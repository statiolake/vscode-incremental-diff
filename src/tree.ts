import * as path from "node:path";
import * as vscode from "vscode";
import { FileStatus } from "./diff";
import { ReviewController } from "./review";
import { ReviewStatus } from "./state";
import { FolderNode, ReviewFile, TreeNode, ViewMode, buildTree, folderChecked } from "./treeModel";

/** Scheme of tree item resource URIs; they only carry decorations and icons. */
export const itemScheme = "incremental-diff-item";

const statusNames: Record<FileStatus, string> = {
  A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type Changed", U: "Unmerged"
};

const statusColors: Record<FileStatus, string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  C: "gitDecoration.addedResourceForeground",
  T: "gitDecoration.modifiedResourceForeground",
  U: "gitDecoration.conflictingResourceForeground"
};

export function itemUri(file: ReviewFile): vscode.Uri {
  const query = new URLSearchParams({ status: file.untracked ? "U?" : file.status, review: file.review });
  return vscode.Uri.from({ scheme: itemScheme, path: `/${file.path}`, query: query.toString() });
}

/** Status letters (A / M / D / R …) and the "changed since review" mark. */
export class FileDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== itemScheme) return undefined;
    const query = new URLSearchParams(uri.query);
    const raw = query.get("status") ?? "";
    const untracked = raw === "U?";
    const status = (untracked ? "A" : raw) as FileStatus;
    if (!(status in statusNames)) return undefined;
    const review = query.get("review") as ReviewStatus;
    const tooltip = [untracked ? "Untracked" : statusNames[status]];
    if (review === "changed") tooltip.push("Changed since review");
    return new vscode.FileDecoration(
      review === "changed" ? `${status}•` : status,
      tooltip.join(", "),
      new vscode.ThemeColor(review === "changed" ? "editorWarning.foreground" : statusColors[status])
    );
  }
}

export class FilesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: TreeNode[] = [];
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: ReviewController) {
    this.subscription = controller.onDidChange(() => this.reload());
  }

  get mode(): ViewMode {
    return vscode.workspace.getConfiguration("incrementalDiff").get<ViewMode>("viewMode", "tree");
  }

  reload(): void {
    this.roots = buildTree(this.controller.files, this.mode);
    this.emitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.roots;
    return element.kind === "folder" ? element.children : [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === "folder" ? this.folderItem(node) : this.fileItem(node.file);
  }

  private folderItem(folder: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder:${folder.path}`;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.resourceUri = vscode.Uri.from({ scheme: itemScheme, path: `/${folder.path}` });
    item.contextValue = "folder";
    const done = folder.files.filter(file => file.review === "reviewed").length;
    item.checkboxState = {
      state: folderChecked(folder) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: `${done} / ${folder.files.length} reviewed`
    };
    item.tooltip = `${folder.path}\n${done} / ${folder.files.length} reviewed`;
    return item;
  }

  private fileItem(file: ReviewFile): vscode.TreeItem {
    const name = path.posix.basename(file.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${file.path}`;
    item.resourceUri = itemUri(file);
    const description: string[] = [];
    if (this.mode === "flat" && file.path.includes("/")) description.push(path.posix.dirname(file.path));
    if (file.oldPath) description.push(`← ${file.oldPath}`);
    if (file.review === "changed") description.push("changed since review");
    item.description = description.join(" · ");
    item.checkboxState = {
      state: file.review === "reviewed" ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: file.review === "reviewed" ? "Reviewed" : "Mark as reviewed"
    };
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendText(file.path);
    if (file.oldPath) tooltip.appendText(`\nRenamed from ${file.oldPath}`);
    tooltip.appendText(`\n${file.untracked ? "Untracked" : statusNames[file.status]}`);
    if (file.mark) tooltip.appendText(`\n${file.review === "changed" ? "Changed since review on" : "Reviewed on"} ${new Date(file.mark.reviewedAt).toLocaleString()}`);
    item.tooltip = tooltip;
    item.contextValue = file.review === "changed" ? "file:changed" : "file";
    item.command = { command: "incrementalDiff.openFileDiff", title: "Open Diff", arguments: [file.path] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

/** Expands checkbox events: a folder toggles every file below it. */
export function checkboxChanges(items: ReadonlyArray<[TreeNode, vscode.TreeItemCheckboxState]>): { reviewed: string[]; unreviewed: string[] } {
  const reviewed = new Set<string>();
  const unreviewed = new Set<string>();
  for (const [node, state] of items) {
    const target = state === vscode.TreeItemCheckboxState.Checked ? reviewed : unreviewed;
    const files = node.kind === "folder" ? node.files : [node.file];
    // Checking a folder only needs to touch the files not reviewed yet.
    for (const file of files) {
      if (target === reviewed && file.review === "reviewed") continue;
      target.add(file.path);
    }
  }
  for (const pathName of reviewed) unreviewed.delete(pathName);
  return { reviewed: [...reviewed], unreviewed: [...unreviewed] };
}
