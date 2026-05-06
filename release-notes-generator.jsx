import { useState, useEffect, useRef } from "react";

const ATLASSIAN_MCP = "https://mcp.atlassian.com/v1/mcp";

// ── Utility: call Anthropic API with MCP ──
async function callClaude(messages, { useMcp = false, useSearch = false, maxTokens = 4096 } = {}) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages,
  };
  if (useMcp) {
    body.mcp_servers = [{ type: "url", url: ATLASSIAN_MCP, name: "atlassian" }];
  }
  if (useSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function extractText(data) {
  if (!data?.content) return "";
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function extractMcpResults(data) {
  if (!data?.content) return [];
  return data.content
    .filter((b) => b.type === "mcp_tool_result")
    .map((b) => {
      try {
        return b.content?.[0]?.text || "";
      } catch {
        return "";
      }
    });
}

// ── Phases ──
const PHASE = { SETUP: 0, FETCHING: 1, TICKETS: 2, GENERATING: 3, RESULT: 4, SLACK_PREVIEW: 5, SLACK_SENDING: 6 };

// ── Styles ──
const palette = {
  bg: "#0B0F1A",
  surface: "#131825",
  surfaceAlt: "#1A2035",
  border: "#252D44",
  borderFocus: "#4F6AFF",
  accent: "#4F6AFF",
  accentSoft: "rgba(79,106,255,0.12)",
  accentGlow: "rgba(79,106,255,0.25)",
  text: "#E2E8F0",
  textMuted: "#8494B2",
  textDim: "#556380",
  success: "#22C55E",
  successSoft: "rgba(34,197,94,0.12)",
  warn: "#F59E0B",
  warnSoft: "rgba(245,158,11,0.12)",
  error: "#EF4444",
};

export default function ReleaseNotesGenerator() {
  const [phase, setPhase] = useState(PHASE.SETUP);
  const [projectKey, setProjectKey] = useState("");
  const [sprintNames, setSprintNames] = useState("");
  const [jqlOverride, setJqlOverride] = useState("");
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [audience, setAudience] = useState("external");
  const [tone, setTone] = useState("professional");
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [releaseNotes, setReleaseNotes] = useState("");
  const [error, setError] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [slackChannel, setSlackChannel] = useState("");
  const [slackStatus, setSlackStatus] = useState(""); // "sent", "error"
  const resultRef = useRef(null);

  // ── Load Jira Projects ──
  async function loadProjects() {
    setLoadingProjects(true);
    try {
      const data = await callClaude(
        [{ role: "user", content: "Use the Atlassian MCP tools to list all visible Jira projects. Return ONLY a JSON array of objects with {key, name}. No markdown fences." }],
        { useMcp: true, maxTokens: 2048 }
      );
      const text = extractText(data);
      const mcpResults = extractMcpResults(data);
      const allText = [text, ...mcpResults].join("\n");
      const jsonMatch = allText.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          setProjects(parsed);
        } catch {}
      }
    } catch (e) {
      setError(`Failed to load projects: ${e.message}`);
    }
    setLoadingProjects(false);
  }

  // ── Step 1: Fetch tickets from Jira ──
  async function fetchTickets() {
    setError("");
    setPhase(PHASE.FETCHING);
    setStatusMsg("Connecting to Jira…");

    try {
      const sprintList = sprintNames.trim()
        ? sprintNames.split(",").map(s => `"${s.trim()}"`).filter(s => s !== '""')
        : [];
      const sprintClause = sprintList.length === 1
        ? ` AND sprint = ${sprintList[0]}`
        : sprintList.length > 1
        ? ` AND sprint in (${sprintList.join(", ")})`
        : "";
      const jql =
        jqlOverride.trim() ||
        `project = "${projectKey.trim()}"${sprintClause} AND status in (Done, Closed, Resolved) ORDER BY issuetype ASC, priority DESC`;

      setStatusMsg("Searching for completed tickets…");

      const data = await callClaude(
        [
          {
            role: "user",
            content: `Use the Atlassian Jira MCP tools to search for issues with this JQL: ${jql}\n\nReturn the results as a JSON array. Each object should have: key, summary, issuetype (Bug, Story, Task, etc.), priority, status, and assignee. If you can't find issues, return an empty array. Respond ONLY with valid JSON, no markdown fences.`,
          },
        ],
        { useMcp: true, maxTokens: 4096 }
      );

      const text = extractText(data);
      const mcpResults = extractMcpResults(data);
      const allText = [text, ...mcpResults].join("\n");

      // Try to parse JSON from the response
      let parsed = [];
      const jsonMatch = allText.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          // Try extracting from text
        }
      }

      if (parsed.length === 0 && allText.includes("key")) {
        // Fallback: ask Claude to re-format
        setStatusMsg("Parsing ticket data…");
        const reformatted = await callClaude([
          {
            role: "user",
            content: `Extract all Jira tickets from this text and return ONLY a JSON array. Each object: {key, summary, issuetype, priority, status, assignee}. Text:\n\n${allText}`,
          },
        ]);
        const rt = extractText(reformatted);
        const m2 = rt.match(/\[[\s\S]*?\]/);
        if (m2) {
          try {
            parsed = JSON.parse(m2[0]);
          } catch {}
        }
      }

      if (!parsed || parsed.length === 0) {
        setError("No completed tickets found. Check your project key and sprint name, or try a custom JQL query.");
        setPhase(PHASE.SETUP);
        return;
      }

      setTickets(parsed);
      setSelected(new Set(parsed.map((t) => t.key)));
      setPhase(PHASE.TICKETS);
    } catch (e) {
      setError(`Failed to fetch tickets: ${e.message}`);
      setPhase(PHASE.SETUP);
    }
  }

  // ── Step 2: Generate release notes ──
  async function generateNotes() {
    setPhase(PHASE.GENERATING);
    setStatusMsg("Crafting release notes…");
    setError("");

    const selectedTickets = tickets.filter((t) => selected.has(t.key));
    const ticketList = selectedTickets
      .map((t) => `- [${t.key}] (${t.issuetype || "Task"}) ${t.summary}`)
      .join("\n");

    const audienceGuide =
      audience === "external"
        ? "Write for end users — focus on benefits, new capabilities, and fixes. Avoid internal jargon or implementation details."
        : audience === "internal"
        ? "Write for the internal team — include technical details, architecture changes, and implementation notes."
        : "Write for stakeholders — balance business impact with high-level technical context.";

    const toneGuide =
      tone === "casual"
        ? "Use a friendly, conversational tone with emoji where appropriate."
        : tone === "professional"
        ? "Use a polished, professional tone suitable for a product changelog."
        : "Use a concise, technical tone focused on specifics.";

    try {
      const data = await callClaude([
        {
          role: "user",
          content: `Generate release notes from these completed Jira tickets:\n\n${ticketList}\n\n## Guidelines\n- ${audienceGuide}\n- ${toneGuide}\n- Group by category (Features, Improvements, Bug Fixes, etc.)\n- Each item should be a clear, one-line description derived from the ticket summary\n- Include the Jira ticket key in parentheses after each item\n- Add a brief intro paragraph summarizing the release\n- Use markdown formatting\n\nRespond with ONLY the release notes in markdown.`,
        },
      ]);

      const notes = extractText(data);
      setReleaseNotes(notes);
      setPhase(PHASE.RESULT);
    } catch (e) {
      setError(`Failed to generate notes: ${e.message}`);
      setPhase(PHASE.TICKETS);
    }
  }

  function toggleTicket(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(tickets.map((t) => t.key)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  const [copied, setCopied] = useState(false);

  function copyNotes() {
    navigator.clipboard.writeText(releaseNotes);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function markdownToHtml(md) {
    return md
      .split("\n")
      .map((line) => {
        if (line.startsWith("### ")) return `<h3>${line.slice(4)}</h3>`;
        if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
        if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
        if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
        if (line.trim() === "") return "";
        return `<p>${line}</p>`;
      })
      .join("\n")
      .replace(/(<li>[\s\S]*?<\/li>)/g, (match) => `<ul>${match}</ul>`)
      .replace(/<\/ul>\s*<ul>/g, "");
  }

  function downloadHtml() {
    const htmlContent = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Release Notes</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 24px; color: #1a1a2e; line-height: 1.7; }
  h1 { font-size: 28px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-top: 32px; }
  h2 { font-size: 20px; color: #4F6AFF; margin-top: 28px; text-transform: uppercase; letter-spacing: 0.03em; font-size: 15px; }
  h3 { font-size: 17px; margin-top: 20px; }
  p { margin: 6px 0; color: #374151; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin: 4px 0; color: #374151; }
  li code, p code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
</style>
</head><body>${markdownToHtml(releaseNotes)}</body></html>`;
    const blob = new Blob([htmlContent], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "release-notes.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPdf() {
    const htmlContent = markdownToHtml(releaseNotes);
    const printWindow = window.open("", "_blank");
    printWindow.document.write(`<!DOCTYPE html>
<html><head><title>Release Notes</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 24px; color: #1a1a2e; line-height: 1.7; }
  h1 { font-size: 26px; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
  h2 { font-size: 18px; color: #4F6AFF; margin-top: 24px; text-transform: uppercase; letter-spacing: 0.03em; font-size: 14px; }
  p { margin: 6px 0; color: #374151; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; color: #374151; }
  @media print { body { margin: 20px; } }
</style>
</head><body>${htmlContent}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 300);
  }

  function prepareSlackPreview() {
    setSlackStatus("");
    setPhase(PHASE.SLACK_PREVIEW);
  }

  function slackPlainText() {
    // Convert markdown to clean plain text for Slack
    return releaseNotes
      .replace(/^# (.+)$/gm, '*$1*')
      .replace(/^## (.+)$/gm, '\n*$1*')
      .replace(/^### (.+)$/gm, '*$1*')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^- /gm, '• ');
  }

  async function sendToSlack() {
    const channel = slackChannel.trim().replace(/^#/, "");
    if (!channel) { setError("Enter a channel name."); return; }
    setPhase(PHASE.SLACK_SENDING);
    setStatusMsg("Posting to #" + channel + "…");
    setError("");

    try {
      const SLACK_MCP = "https://mcp.slack.com/mcp";
      const plainText = slackPlainText();
      const data = await callClaude(
        [{
          role: "user",
          content: `Use the Slack MCP tools to send a message to the channel "#${channel}". Post this exact message content (do not modify or summarize it):\n\n${plainText}`
        }],
        { useMcp: false, maxTokens: 2048 }
      );
      // Override: use Slack MCP directly
      const slackBody = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: `Use the Slack MCP tools to post a message to channel "#${channel}". Send this exact text as the message body — do not summarize or change it:\n\n${plainText}`
        }],
        mcp_servers: [{ type: "url", url: SLACK_MCP, name: "slack" }],
      };
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackBody),
      });
      const result = await res.json();
      const resultText = extractText(result);
      const mcpResults = extractMcpResults(result);

      // Check for errors in the response
      const allText = [resultText, ...mcpResults].join("\n").toLowerCase();
      if (allText.includes("error") && !allText.includes("no error")) {
        setError("Slack returned an error — check the channel name and make sure the Slack app has access.");
        setPhase(PHASE.SLACK_PREVIEW);
      } else {
        setSlackStatus("sent");
        setPhase(PHASE.RESULT);
      }
    } catch (e) {
      setError(`Failed to send to Slack: ${e.message}`);
      setPhase(PHASE.SLACK_PREVIEW);
    }
  }

  function startOver() {
    setPhase(PHASE.SETUP);
    setTickets([]);
    setSelected(new Set());
    setReleaseNotes("");
    setError("");
  }

  // ── Render helpers ──
  const issueTypeIcon = (type) => {
    const t = (type || "").toLowerCase();
    if (t.includes("bug")) return { icon: "🐛", color: palette.error };
    if (t.includes("story")) return { icon: "📖", color: palette.accent };
    if (t.includes("epic")) return { icon: "⚡", color: palette.warn };
    if (t.includes("sub")) return { icon: "🔹", color: palette.textMuted };
    return { icon: "✅", color: palette.success };
  };

  // ── Markdown rendering (lightweight) ──
  function renderMarkdown(md) {
    const lines = md.split("\n");
    const elements = [];
    let i = 0;
    for (const line of lines) {
      i++;
      if (line.startsWith("# "))
        elements.push(<h1 key={i} style={{ fontSize: 22, fontWeight: 700, margin: "20px 0 8px", color: palette.text, fontFamily: "'Instrument Serif', Georgia, serif" }}>{line.slice(2)}</h1>);
      else if (line.startsWith("## "))
        elements.push(<h2 key={i} style={{ fontSize: 17, fontWeight: 600, margin: "18px 0 6px", color: palette.accent, fontFamily: "'DM Sans', sans-serif", letterSpacing: "0.02em", textTransform: "uppercase" }}>{line.slice(3)}</h2>);
      else if (line.startsWith("### "))
        elements.push(<h3 key={i} style={{ fontSize: 15, fontWeight: 600, margin: "14px 0 4px", color: palette.text }}>{line.slice(4)}</h3>);
      else if (line.startsWith("- "))
        elements.push(<div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", marginLeft: 8 }}><span style={{ color: palette.accent, flexShrink: 0 }}>•</span><span style={{ color: palette.textMuted, lineHeight: 1.6, fontSize: 13.5 }}>{line.slice(2)}</span></div>);
      else if (line.trim() === "")
        elements.push(<div key={i} style={{ height: 6 }} />);
      else
        elements.push(<p key={i} style={{ color: palette.textMuted, lineHeight: 1.7, fontSize: 13.5, margin: "4px 0" }}>{line}</p>);
    }
    return elements;
  }

  // ── Main Render ──
  return (
    <div style={{ minHeight: "100vh", background: palette.bg, fontFamily: "'DM Sans', sans-serif", color: palette.text, padding: "0 0 40px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Instrument+Serif&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ padding: "28px 32px 20px", borderBottom: `1px solid ${palette.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg, ${palette.accent}, #7C3AED)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📋</div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, fontFamily: "'Instrument Serif', Georgia, serif", letterSpacing: "-0.01em" }}>Release Notes Generator</h1>
            <p style={{ fontSize: 12, color: palette.textDim, margin: "2px 0 0" }}>Pull from Jira → Select tickets → Generate polished notes</p>
          </div>
        </div>
        {/* Progress steps */}
        <div style={{ display: "flex", gap: 0, marginTop: 20 }}>
          {["Configure", "Select Tickets", "Release Notes"].map((label, idx) => {
            const active = (idx === 0 && phase <= 1) || (idx === 1 && phase === 2) || (idx === 2 && phase >= 3);
            const done = (idx === 0 && phase >= 2) || (idx === 1 && phase >= 3) || (idx === 2 && phase === 4);
            return (
              <div key={label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ height: 3, width: "100%", borderRadius: 2, background: done ? palette.accent : active ? palette.accentGlow : palette.border, transition: "all 0.3s" }} />
                <span style={{ fontSize: 11, fontWeight: 500, color: active || done ? palette.text : palette.textDim, transition: "color 0.3s" }}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 20px" }}>
        {error && (
          <div style={{ background: "rgba(239,68,68,0.1)", border: `1px solid rgba(239,68,68,0.25)`, borderRadius: 10, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#FCA5A5" }}>
            {error}
          </div>
        )}

        {/* ── SETUP PHASE ── */}
        {phase === PHASE.SETUP && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <label style={labelStyle}>Project Key <span style={{ color: palette.accent }}>*</span></label>
              <div style={{ display: "flex", gap: 8 }}>
                {projects.length > 0 ? (
                  <select
                    style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                    value={projectKey}
                    onChange={(e) => setProjectKey(e.target.value)}
                  >
                    <option value="">Select a project…</option>
                    {projects.map((p) => (
                      <option key={p.key} value={p.key}>{p.key} — {p.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="e.g. PROJ, ENG, MOBILE"
                    value={projectKey}
                    onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
                  />
                )}
                <button
                  onClick={loadProjects}
                  disabled={loadingProjects}
                  style={{ ...btnSecondary, whiteSpace: "nowrap", fontSize: 12, padding: "10px 14px" }}
                >
                  {loadingProjects ? "Loading…" : projects.length > 0 ? "Refresh" : "Load from Jira"}
                </button>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Sprint Names <span style={{ color: palette.textDim, fontWeight: 400 }}>(comma-separated, optional)</span></label>
              <input
                style={inputStyle}
                placeholder="e.g. Sprint 24, Sprint 25, Sprint 26"
                value={sprintNames}
                onChange={(e) => setSprintNames(e.target.value)}
              />
              <p style={{ fontSize: 11, color: palette.textDim, marginTop: 4 }}>Enter one or more sprint names separated by commas. Leave blank for all completed tickets.</p>
            </div>
            <div>
              <label style={labelStyle}>Custom JQL <span style={{ color: palette.textDim, fontWeight: 400 }}>(overrides above)</span></label>
              <textarea
                style={{ ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                placeholder='e.g. project = "ENG" AND fixVersion = "2.1.0" AND status = Done'
                value={jqlOverride}
                onChange={(e) => setJqlOverride(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Audience</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[["external", "External"], ["internal", "Internal"], ["stakeholder", "Stakeholders"]].map(([val, lbl]) => (
                    <button key={val} onClick={() => setAudience(val)} style={{ ...chipStyle, ...(audience === val ? chipActiveStyle : {}) }}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Tone</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[["professional", "Professional"], ["casual", "Casual"], ["technical", "Technical"]].map(([val, lbl]) => (
                    <button key={val} onClick={() => setTone(val)} style={{ ...chipStyle, ...(tone === val ? chipActiveStyle : {}) }}>{lbl}</button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label style={labelStyle}>Slack Channel <span style={{ color: palette.textDim, fontWeight: 400 }}>(optional — for posting notes later)</span></label>
              <input
                style={inputStyle}
                placeholder="e.g. #product-updates"
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
              />
            </div>

            <button
              onClick={fetchTickets}
              disabled={!projectKey.trim() && !jqlOverride.trim()}
              style={{
                ...btnPrimary,
                opacity: !projectKey.trim() && !jqlOverride.trim() ? 0.4 : 1,
                cursor: !projectKey.trim() && !jqlOverride.trim() ? "not-allowed" : "pointer",
              }}
            >
              Fetch Completed Tickets →
            </button>
          </div>
        )}

        {/* ── FETCHING PHASE ── */}
        {phase === PHASE.FETCHING && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={spinnerStyle} />
            <p style={{ color: palette.textMuted, fontSize: 14, marginTop: 20 }}>{statusMsg}</p>
          </div>
        )}

        {/* ── TICKET SELECTION PHASE ── */}
        {phase === PHASE.TICKETS && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{tickets.length} tickets found</span>
                <span style={{ color: palette.textDim, fontSize: 13, marginLeft: 8 }}>{selected.size} selected</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={selectAll} style={btnSmall}>Select All</button>
                <button onClick={selectNone} style={btnSmall}>Clear</button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 400, overflowY: "auto", paddingRight: 4 }}>
              {tickets.map((t) => {
                const isSelected = selected.has(t.key);
                const { icon, color } = issueTypeIcon(t.issuetype);
                return (
                  <div
                    key={t.key}
                    onClick={() => toggleTicket(t.key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                      borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                      background: isSelected ? palette.accentSoft : "transparent",
                      border: `1px solid ${isSelected ? palette.borderFocus : palette.border}`,
                    }}
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: 5, border: `2px solid ${isSelected ? palette.accent : palette.textDim}`,
                      background: isSelected ? palette.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, color: "#fff", flexShrink: 0, transition: "all 0.15s",
                    }}>
                      {isSelected && "✓"}
                    </div>
                    <span style={{ fontSize: 14 }}>{icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color, fontWeight: 600 }}>{t.key}</span>
                        <span style={{ fontSize: 13, color: palette.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.summary}</span>
                      </div>
                      <div style={{ fontSize: 11, color: palette.textDim, marginTop: 2 }}>
                        {t.issuetype || "Task"}{t.assignee ? ` · ${t.assignee}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button onClick={() => setPhase(PHASE.SETUP)} style={btnSecondary}>← Back</button>
              <button
                onClick={generateNotes}
                disabled={selected.size === 0}
                style={{ ...btnPrimary, flex: 1, opacity: selected.size === 0 ? 0.4 : 1, cursor: selected.size === 0 ? "not-allowed" : "pointer" }}
              >
                Generate Release Notes ({selected.size} tickets) →
              </button>
            </div>
          </div>
        )}

        {/* ── GENERATING PHASE ── */}
        {phase === PHASE.GENERATING && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={spinnerStyle} />
            <p style={{ color: palette.textMuted, fontSize: 14, marginTop: 20 }}>{statusMsg}</p>
          </div>
        )}

        {/* ── RESULT PHASE ── */}
        {phase === PHASE.RESULT && (
          <div>
            <div ref={resultRef} style={{
              background: palette.surface, border: `1px solid ${palette.border}`, borderRadius: 14,
              padding: "28px 28px 24px", marginBottom: 20,
            }}>
              {renderMarkdown(releaseNotes)}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={copyNotes} style={btnPrimary}>{copied ? "✓ Copied!" : "📋 Copy Markdown"}</button>
              <button onClick={downloadHtml} style={btnSecondary}>⬇ Download HTML</button>
              <button onClick={downloadPdf} style={btnSecondary}>⬇ Save as PDF</button>
              {slackChannel.trim() && (
                <button onClick={prepareSlackPreview} style={{ ...btnSecondary, borderColor: "#4A154B", color: "#E8D5EA" }}>
                  💬 Send to #{slackChannel.trim().replace(/^#/, "")}
                </button>
              )}
              <button onClick={() => setPhase(PHASE.TICKETS)} style={btnSecondary}>← Edit Selection</button>
              <button onClick={startOver} style={btnSecondary}>↺ Start Over</button>
            </div>
            {slackStatus === "sent" && (
              <div style={{ marginTop: 12, background: palette.successSoft, border: `1px solid rgba(34,197,94,0.25)`, borderRadius: 10, padding: "10px 16px", fontSize: 13, color: "#86EFAC" }}>
                ✓ Posted to #{slackChannel.trim().replace(/^#/, "")} successfully
              </div>
            )}
          </div>
        )}

        {/* ── SLACK PREVIEW PHASE ── */}
        {phase === PHASE.SLACK_PREVIEW && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 18 }}>💬</span>
                <span style={{ fontSize: 15, fontWeight: 600 }}>Preview: #{slackChannel.trim().replace(/^#/, "")}</span>
              </div>
              <p style={{ fontSize: 12, color: palette.textDim, marginBottom: 12 }}>This is exactly what will be posted to Slack:</p>
            </div>

            <div style={{
              background: "#1A1D21", border: `1px solid ${palette.border}`, borderRadius: 10,
              padding: "20px 20px 16px", marginBottom: 20, fontFamily: "'Lato', 'DM Sans', sans-serif",
              whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6, color: "#D1D2D3",
            }}>
              {slackPlainText()}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setPhase(PHASE.RESULT)} style={btnSecondary}>← Back to Notes</button>
              <button onClick={sendToSlack} style={{ ...btnPrimary, flex: 1, background: "linear-gradient(135deg, #4A154B, #7C3AED)" }}>
                Post to #{slackChannel.trim().replace(/^#/, "")} →
              </button>
            </div>
          </div>
        )}

        {/* ── SLACK SENDING PHASE ── */}
        {phase === PHASE.SLACK_SENDING && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={spinnerStyle} />
            <p style={{ color: palette.textMuted, fontSize: 14, marginTop: 20 }}>{statusMsg}</p>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input:focus, textarea:focus { outline: none; border-color: ${palette.borderFocus} !important; box-shadow: 0 0 0 3px ${palette.accentGlow}; }
        button:hover:not(:disabled) { filter: brightness(1.1); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${palette.border}; border-radius: 3px; }
      `}</style>
    </div>
  );
}

// ── Shared Styles ──
const labelStyle = {
  display: "block", fontSize: 12, fontWeight: 600, color: "#8494B2",
  marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em",
};
const inputStyle = {
  width: "100%", padding: "10px 14px", background: "#131825",
  border: "1px solid #252D44", borderRadius: 10, color: "#E2E8F0",
  fontSize: 14, fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box",
  transition: "border-color 0.15s, box-shadow 0.15s",
};
const chipStyle = {
  padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 500,
  border: "1px solid #252D44", background: "transparent", color: "#8494B2",
  cursor: "pointer", transition: "all 0.15s", fontFamily: "'DM Sans', sans-serif",
};
const chipActiveStyle = {
  background: "rgba(79,106,255,0.12)", borderColor: "#4F6AFF", color: "#4F6AFF",
};
const btnPrimary = {
  padding: "12px 24px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
  background: "linear-gradient(135deg, #4F6AFF, #7C3AED)", color: "#fff",
  cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
};
const btnSecondary = {
  padding: "12px 20px", borderRadius: 10, border: "1px solid #252D44", fontSize: 14, fontWeight: 500,
  background: "transparent", color: "#8494B2", cursor: "pointer",
  fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
};
const btnSmall = {
  padding: "4px 12px", borderRadius: 6, border: "1px solid #252D44", fontSize: 11, fontWeight: 500,
  background: "transparent", color: "#8494B2", cursor: "pointer",
  fontFamily: "'DM Sans', sans-serif",
};
const spinnerStyle = {
  width: 36, height: 36, border: "3px solid #252D44", borderTopColor: "#4F6AFF",
  borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto",
};
