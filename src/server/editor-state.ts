/**
 * Server-owned editor tab state.
 *
 * Tracks which files are open, their order, and which tab is active.
 * The frontend renders tabs from this state. Both user actions and
 * remy agent actions can manipulate tabs — the server is the source
 * of truth.
 *
 * Does NOT manage buffer content, cursor position, undo history, or
 * selections — those live in Monaco on the frontend.
 */

import type { EditorTab, EditorState } from '../types.js';

type ChangeCallback = (state: EditorState) => void;

export class EditorStateManager {
  private tabs: EditorTab[] = [];
  private activeTab: string | null = null;
  private onChange: ChangeCallback;

  constructor(onChange: ChangeCallback) {
    this.onChange = onChange;
  }

  getState(): EditorState {
    return {
      tabs: [...this.tabs],
      activeTab: this.activeTab,
    };
  }

  /**
   * Open a file. If already open, just activate it.
   * If `preview` is true, the tab is a preview tab — it gets replaced
   * by the next preview-open (single-click in file tree).
   * If `preview` is false, the tab is pinned (double-click / explicit open).
   */
  openFile(path: string, preview: boolean = false): void {
    const existing = this.tabs.find((t) => t.path === path);

    if (existing) {
      // Already open — activate it. If it was preview and this is a pin, upgrade it.
      if (!preview && existing.isPreview) {
        existing.isPreview = false;
      }
      this.activeTab = path;
      this.emit();
      return;
    }

    // If opening as preview, replace any existing preview tab
    if (preview) {
      const previewIdx = this.tabs.findIndex((t) => t.isPreview);
      if (previewIdx !== -1) {
        this.tabs.splice(previewIdx, 1, { path, isPreview: true });
        this.activeTab = path;
        this.emit();
        return;
      }
    }

    // Add new tab
    this.tabs.push({ path, isPreview: preview });
    this.activeTab = path;
    this.emit();
  }

  /** Close a tab. Activates an adjacent tab if the closed tab was active. */
  closeFile(path: string): void {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx === -1) {
      return;
    }

    this.tabs.splice(idx, 1);

    if (this.activeTab === path) {
      if (this.tabs.length === 0) {
        this.activeTab = null;
      } else {
        // Activate the tab at the same index (or the last one)
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTab = this.tabs[newIdx].path;
      }
    }

    this.emit();
  }

  /** Set the active tab without opening/closing. */
  setActiveTab(path: string): void {
    if (!this.tabs.find((t) => t.path === path)) {
      return;
    }
    this.activeTab = path;
    this.emit();
  }

  /** Reorder tabs. `paths` is the new order of all tab paths. */
  reorderTabs(paths: string[]): void {
    const tabMap = new Map(this.tabs.map((t) => [t.path, t]));
    const reordered: EditorTab[] = [];
    for (const p of paths) {
      const tab = tabMap.get(p);
      if (tab) {
        reordered.push(tab);
      }
    }
    this.tabs = reordered;
    this.emit();
  }

  /**
   * Handle a file being deleted or renamed — close/update affected tabs.
   * Called from the file watcher or rename/delete actions.
   */
  onFileDeleted(path: string): void {
    if (this.tabs.some((t) => t.path === path)) {
      this.closeFile(path);
    }
  }

  onFileRenamed(oldPath: string, newPath: string): void {
    const tab = this.tabs.find((t) => t.path === oldPath);
    if (tab) {
      tab.path = newPath;
      if (this.activeTab === oldPath) {
        this.activeTab = newPath;
      }
      this.emit();
    }
  }

  /** Restore from persisted state. */
  hydrate(state: EditorState): void {
    this.tabs = state.tabs.map((t) => ({ ...t }));
    this.activeTab = state.activeTab;
  }

  private emit(): void {
    this.onChange(this.getState());
  }
}
