/**
 * Server-owned editor & workspace UI state.
 *
 * Tracks which files are open, their order, which tab is active,
 * and which directories are expanded in the file tree. The frontend
 * renders from this state. Both user actions and the remy agent can
 * manipulate it — the server is the source of truth.
 *
 * Does NOT manage buffer content, cursor position, undo history, or
 * selections — those live in Monaco on the frontend.
 */

import path from 'node:path';
import type { EditorTab, EditorState, AppConfig } from '../types.js';

type ChangeCallback = (state: EditorState) => void;

export class EditorStateManager {
  private tabs: EditorTab[] = [];
  private activeTab: string | null = null;
  private expandedDirs = new Set<string>();
  private onChange: ChangeCallback;

  constructor(onChange: ChangeCallback) {
    this.onChange = onChange;
  }

  getState(): EditorState {
    return {
      tabs: [...this.tabs],
      activeTab: this.activeTab,
      expandedDirs: Array.from(this.expandedDirs).sort(),
    };
  }

  // --- Tabs ---

  /**
   * Open a file. If already open, just activate it.
   * If `preview` is true, the tab is a preview tab — it gets replaced
   * by the next preview-open (single-click in file tree).
   * If `preview` is false, the tab is pinned (double-click / explicit open).
   */
  openFile(path: string, preview: boolean = false): void {
    const existing = this.tabs.find((t) => t.path === path);

    if (existing) {
      if (!preview && existing.isPreview) {
        existing.isPreview = false;
      }
      this.activeTab = path;
      this.emit();
      return;
    }

    if (preview) {
      const previewIdx = this.tabs.findIndex((t) => t.isPreview);
      if (previewIdx !== -1) {
        this.tabs.splice(previewIdx, 1, { path, isPreview: true });
        this.activeTab = path;
        this.emit();
        return;
      }
    }

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

  // --- Directory tree ---

  /** Expand a directory in the file tree. */
  expandDir(path: string): void {
    if (this.expandedDirs.has(path)) {
      return;
    }
    this.expandedDirs.add(path);
    this.emit();
  }

  /** Collapse a directory in the file tree. */
  collapseDir(path: string): void {
    if (!this.expandedDirs.has(path)) {
      return;
    }
    this.expandedDirs.delete(path);
    // Also collapse any children
    for (const dir of this.expandedDirs) {
      if (dir.startsWith(path + '/')) {
        this.expandedDirs.delete(dir);
      }
    }
    this.emit();
  }

  /** Toggle a directory's expanded state. */
  toggleDir(path: string): void {
    if (this.expandedDirs.has(path)) {
      this.collapseDir(path);
    } else {
      this.expandDir(path);
    }
  }

  // --- File lifecycle ---

  onFileDeleted(path: string): void {
    if (this.tabs.some((t) => t.path === path)) {
      this.closeFile(path);
    }
    // Collapse deleted directories
    this.expandedDirs.delete(path);
    for (const dir of this.expandedDirs) {
      if (dir.startsWith(path + '/')) {
        this.expandedDirs.delete(dir);
      }
    }
  }

  onFileRenamed(oldPath: string, newPath: string): void {
    // Update tabs
    const tab = this.tabs.find((t) => t.path === oldPath);
    if (tab) {
      tab.path = newPath;
      if (this.activeTab === oldPath) {
        this.activeTab = newPath;
      }
    }

    // Update expanded dirs
    if (this.expandedDirs.has(oldPath)) {
      this.expandedDirs.delete(oldPath);
      this.expandedDirs.add(newPath);
    }
    for (const dir of this.expandedDirs) {
      if (dir.startsWith(oldPath + '/')) {
        this.expandedDirs.delete(dir);
        this.expandedDirs.add(newPath + dir.slice(oldPath.length));
      }
    }

    if (tab) {
      this.emit();
    }
  }

  /** Restore from persisted state. */
  hydrate(state: EditorState): void {
    this.tabs = state.tabs.map((t) => ({ ...t }));
    this.activeTab = state.activeTab;
    this.expandedDirs = new Set(state.expandedDirs ?? []);
  }

  /** Returns true if any state exists (tabs or expanded dirs). */
  isEmpty(): boolean {
    return this.tabs.length === 0 && this.expandedDirs.size === 0;
  }

  /**
   * Pre-expand directories based on the app config so new sessions
   * show the user's code immediately. Expands the containing directories
   * for all methods, tables, and web interfaces.
   */
  expandFromAppConfig(appConfig: AppConfig): void {
    const dirs = new Set<string>();

    // Collect the containing directory for each method/table file
    for (const m of appConfig.methods ?? []) {
      dirs.add(path.dirname(m.path));
    }
    for (const t of appConfig.tables ?? []) {
      dirs.add(path.dirname(t.path));
    }
    // For interfaces, expand the directory containing the config file
    for (const i of appConfig.interfaces ?? []) {
      dirs.add(path.dirname(i.path));
    }

    // Expand each directory and all its ancestors
    for (const dir of dirs) {
      let current = dir;
      while (current && current !== '.') {
        this.expandedDirs.add(current);
        current = path.dirname(current);
      }
    }

    this.emit();
  }

  private emit(): void {
    this.onChange(this.getState());
  }
}
