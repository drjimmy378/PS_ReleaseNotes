import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ReleaseNotesGenerator from "../release-notes-generator.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ReleaseNotesGenerator />
  </StrictMode>
);
