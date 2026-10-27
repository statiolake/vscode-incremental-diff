import { ChangedFile } from "./diff";
import { ReviewMark, ReviewStatus } from "./state";

export interface ReviewFile extends ChangedFile {
  review: ReviewStatus;
  mark?: ReviewMark;
}

export interface FolderNode {
  kind: "folder";
  /** Full folder path relative to the repository root, e.g. `src/util`. */
  path: string;
  /** Displayed label; compacted chains read `src/util`. */
  label: string;
  children: TreeNode[];
  /** Every file below this folder. */
  files: ReviewFile[];
}

export interface FileNode {
  kind: "file";
  file: ReviewFile;
}

export type TreeNode = FolderNode | FileNode;

export type ViewMode = "tree" | "flat";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Arranges files as a folder hierarchy (single-child folder chains compacted,
 * folders before files) or as a flat list sorted by path.
 */
export function buildTree(files: ReviewFile[], mode: ViewMode): TreeNode[] {
  if (mode === "flat") {
    return [...files].sort((a, b) => compare(a.path, b.path)).map(file => ({ kind: "file", file }));
  }
  const root: FolderNode = { kind: "folder", path: "", label: "", children: [], files: [] };
  const folders = new Map<string, FolderNode>([["", root]]);
  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = folderFor(slash < 0 ? "" : path.slice(0, slash));
    const folder: FolderNode = { kind: "folder", path, label: path.slice(slash + 1), children: [], files: [] };
    parent.children.push(folder);
    folders.set(path, folder);
    return folder;
  };
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    folderFor(slash < 0 ? "" : file.path.slice(0, slash)).children.push({ kind: "file", file });
  }
  const finish = (folder: FolderNode): ReviewFile[] => {
    folder.children = folder.children.map(child => child.kind === "folder" ? compact(child) : child);
    folder.children.sort((a, b) => a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1)
      : compare(a.kind === "folder" ? a.label : basename(a.file.path), b.kind === "folder" ? b.label : basename(b.file.path)));
    folder.files = folder.children.flatMap(child => child.kind === "folder" ? finish(child) : [child.file]);
    return folder.files;
  };
  const compact = (folder: FolderNode): FolderNode => {
    while (folder.children.length === 1 && folder.children[0].kind === "folder") {
      const only = folder.children[0];
      folder = { ...only, label: `${folder.label}/${only.label}` };
    }
    return folder;
  };
  finish(root);
  return root.children;
}

/** Files in display order (depth first through the tree). */
export function flattenTree(nodes: TreeNode[]): ReviewFile[] {
  return nodes.flatMap(node => node.kind === "folder" ? flattenTree(node.children) : [node.file]);
}

/** A folder is checked when every file below it is reviewed. */
export function folderChecked(folder: FolderNode): boolean {
  return folder.files.length > 0 && folder.files.every(file => file.review === "reviewed");
}

/** The next file needing review after `path` in display order, wrapping around. */
export function nextUnreviewed(order: ReviewFile[], path: string | undefined): ReviewFile | undefined {
  const start = path === undefined ? -1 : order.findIndex(file => file.path === path);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step + order.length) % order.length];
    if (candidate.review !== "reviewed" && candidate.path !== path) return candidate;
  }
  return undefined;
}
