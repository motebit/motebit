import type { MemoryNode } from "../index";
import type { DesktopContext } from "../types";
import { formatTimeAgo } from "../types";

// === DOM Refs ===

const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
const memoryBackdrop = document.getElementById("memory-backdrop") as HTMLDivElement;
const memoryList = document.getElementById("memory-list") as HTMLDivElement;
const memoryCount = document.getElementById("memory-count") as HTMLSpanElement;
const memorySearch = document.getElementById("memory-search") as HTMLInputElement;

// === Memory Panel ===

export interface MemoryAPI {
  open(): void;
  close(): void;
}

let allMemories: MemoryNode[] = [];

export function initMemory(ctx: DesktopContext): MemoryAPI {
  function open(): void {
    memoryPanel.classList.add("open");
    memoryBackdrop.classList.add("open");
    refreshMemoryList();
  }

  function close(): void {
    memoryPanel.classList.remove("open");
    memoryBackdrop.classList.remove("open");
  }

  function refreshMemoryList(): void {
    memoryList.innerHTML = "";
    void ctx.app.listMemories().then(memories => {
      allMemories = memories;
      memoryCount.textContent = String(memories.length);
      renderMemoryItems(memories, memorySearch.value.trim());
    });
  }

  function renderMemoryItems(memories: MemoryNode[], query: string): void {
    memoryList.innerHTML = "";
    const filtered = query
      ? memories.filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
      : memories;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = query ? "No matches" : "No memories yet";
      memoryList.appendChild(empty);
      return;
    }

    for (const mem of filtered) {
      const item = document.createElement("div");
      item.className = "mem-item";

      const contentDiv = document.createElement("div");
      contentDiv.className = "mem-item-content";
      contentDiv.textContent = mem.content;
      item.appendChild(contentDiv);

      const metaDiv = document.createElement("div");
      metaDiv.className = "mem-item-meta";

      if (mem.sensitivity && mem.sensitivity !== "none") {
        const badge = document.createElement("span");
        badge.className = `mem-sensitivity-badge ${mem.sensitivity}`;
        badge.textContent = mem.sensitivity;
        metaDiv.appendChild(badge);
      }

      const conf = document.createElement("span");
      const decayed = ctx.app.getDecayedConfidence(mem);
      conf.textContent = `${Math.round(decayed * 100)}%`;
      metaDiv.appendChild(conf);

      const time = document.createElement("span");
      time.textContent = formatTimeAgo(mem.created_at);
      metaDiv.appendChild(time);

      item.appendChild(metaDiv);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "mem-delete-btn";
      deleteBtn.textContent = "\u00d7";
      deleteBtn.title = "Delete memory";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void ctx.app.deleteMemory(mem.node_id).then(() => {
          refreshMemoryList();
        });
      });
      item.appendChild(deleteBtn);

      memoryList.appendChild(item);
    }
  }

  // Debounced search
  let memorySearchTimeout: ReturnType<typeof setTimeout> | null = null;
  memorySearch.addEventListener("input", () => {
    if (memorySearchTimeout) clearTimeout(memorySearchTimeout);
    memorySearchTimeout = setTimeout(() => {
      renderMemoryItems(allMemories, memorySearch.value.trim());
    }, 200);
  });

  // Event listeners
  document.getElementById("memory-btn")!.addEventListener("click", open);
  document.getElementById("memory-close-btn")!.addEventListener("click", close);
  memoryBackdrop.addEventListener("click", close);

  return { open, close };
}
