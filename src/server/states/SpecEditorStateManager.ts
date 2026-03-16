/**
 * Server-owned spec editor state.
 *
 * Simplified variant of EditorStateManager for spec mode — tabs only,
 * no expandedDirs (the spec sidebar is flat sections, not a tree).
 * Same tab semantics: preview tabs, pinned tabs, adjacent activation.
 */

import type { EditorTab } from './EditorStateManager.js';

export interface SpecEditorState {
  tabs: EditorTab[];
  activeTab: string | null;
}

type ChangeCallback = (state: SpecEditorState) => void;

export class SpecEditorStateManager {
  private tabs: EditorTab[] = [];
  private activeTab: string | null = null;
  private onChange: ChangeCallback;

  constructor(onChange: ChangeCallback) {
    this.onChange = onChange;
  }

  getState(): SpecEditorState {
    return {
      tabs: [...this.tabs],
      activeTab: this.activeTab,
    };
  }

  // --- Tabs ---

  /**
   * Open a file. If already open, just activate it.
   * If `preview` is true, the tab is a preview tab — it gets replaced
   * by the next preview-open (single-click in file sidebar).
   */
  openFile(filePath: string, preview: boolean = false): void {
    const existing = this.tabs.find((t) => t.path === filePath);

    if (existing) {
      if (!preview && existing.isPreview) {
        existing.isPreview = false;
      }
      this.activeTab = filePath;
      this.emit();
      return;
    }

    if (preview) {
      const previewIdx = this.tabs.findIndex((t) => t.isPreview);
      if (previewIdx !== -1) {
        this.tabs.splice(previewIdx, 1, { path: filePath, isPreview: true });
        this.activeTab = filePath;
        this.emit();
        return;
      }
    }

    this.tabs.push({ path: filePath, isPreview: preview });
    this.activeTab = filePath;
    this.emit();
  }

  /** Close a tab. Activates an adjacent tab if the closed tab was active. */
  closeFile(filePath: string): void {
    const idx = this.tabs.findIndex((t) => t.path === filePath);
    if (idx === -1) {
      return;
    }

    this.tabs.splice(idx, 1);

    if (this.activeTab === filePath) {
      if (this.tabs.length === 0) {
        this.activeTab = null;
      } else {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTab = this.tabs[newIdx].path;
      }
    }

    this.emit();
  }

  /** Set the active tab without opening/closing. */
  setActiveTab(filePath: string): void {
    if (!this.tabs.find((t) => t.path === filePath)) {
      return;
    }
    this.activeTab = filePath;
    this.emit();
  }

  // --- File lifecycle ---

  onFileDeleted(filePath: string): void {
    if (this.tabs.some((t) => t.path === filePath)) {
      this.closeFile(filePath);
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
  hydrate(state: SpecEditorState): void {
    this.tabs = state.tabs.map((t) => ({ ...t }));
    this.activeTab = state.activeTab;
  }

  /** Returns true if no tabs are open. */
  isEmpty(): boolean {
    return this.tabs.length === 0;
  }

  private emit(): void {
    this.onChange(this.getState());
  }
}
