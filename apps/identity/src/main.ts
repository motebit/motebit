/**
 * Identity profile — main entry point.
 * DOM wiring, drag-drop, file reading.
 */

import { verify } from "./verify.js";
import { parse } from "./parse.js";
import { renderProfileCard } from "./render.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const dropZone = document.getElementById("drop-zone")!;
const fileInput = document.getElementById("file-input")! as HTMLInputElement;
const browseBtn = document.getElementById("browse-btn")!;
const cardContainer = document.getElementById("card-container")!;
const errorContainer = document.getElementById("error-container")!;
const resetBtn = document.getElementById("reset-btn")!;

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

async function handleFile(file: File): Promise<void> {
  errorContainer.textContent = "";
  errorContainer.classList.remove("visible");
  cardContainer.innerHTML = "";

  const text = await file.text();

  if (!text.includes("---")) {
    showError(
      "This does not appear to be a motebit.md identity file. Expected YAML frontmatter between --- delimiters.",
    );
    return;
  }

  const result = await verify(text);

  if (result.identity) {
    dropZone.classList.add("hidden");
    resetBtn.classList.add("visible");
    renderProfileCard(cardContainer, result.identity, result.valid);
  } else if (result.error) {
    // Parse succeeded enough to get an error but no identity
    // Try to show partial data even if signature is invalid
    try {
      const parsed = parse(text);
      dropZone.classList.add("hidden");
      resetBtn.classList.add("visible");
      renderProfileCard(cardContainer, parsed.frontmatter, false);
    } catch {
      showError(result.error);
    }
  } else {
    showError("Could not parse the identity file.");
  }
}

function showError(msg: string): void {
  errorContainer.textContent = msg;
  errorContainer.classList.add("visible");
}

function reset(): void {
  cardContainer.innerHTML = "";
  errorContainer.textContent = "";
  errorContainer.classList.remove("visible");
  dropZone.classList.remove("hidden");
  resetBtn.classList.remove("visible");
  fileInput.value = "";
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Drag and drop
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files[0];
  if (file) {
    void handleFile(file);
  }
});

// File picker
browseBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    void handleFile(file);
  }
});

// Reset
resetBtn.addEventListener("click", reset);
