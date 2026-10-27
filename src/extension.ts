import * as vscode from "vscode";
import { BlobContentProvider, contentScheme } from "./content";
import { getGitApi } from "./gitApi";
import { ReviewController, OpenRequest, MultiDiffKind } from "./review";
import { ReviewStateStore } from "./state";
import { FileDecorations, FilesTreeProvider, checkboxChanges } from "./tree";
import { ReviewFile, TreeNode } from "./treeModel";

export interface IncrementalDiffApi {
  readonly controller: ReviewController;
}

export async function activate(context: vscode.ExtensionContext): Promise<IncrementalDiffApi> {
  const store = new ReviewStateStore(context.workspaceState);
  const controller = new ReviewController(store, await getGitApi());
  const tree = new FilesTreeProvider(controller);
  const view = vscode.window.createTreeView("incrementalDiff.files", {
    treeDataProvider: tree,
    manageCheckboxStateManually: true,
    showCollapseAll: true
  });

  const updateView = () => {
    const files = controller.files;
    const reviewed = files.filter(file => file.review === "reviewed").length;
    const changed = files.filter(file => file.review === "changed").length;
    view.description = controller.title;
    if (!controller.active) view.message = undefined;
    else if (controller.error) view.message = `Error: ${controller.error}`;
    else if (files.length === 0) view.message = "No changes.";
    else view.message = `${reviewed} / ${files.length} reviewed${changed ? ` · ${changed} changed since review` : ""}`;
    view.badge = controller.active && files.length > reviewed
      ? { value: files.length - reviewed, tooltip: `${files.length - reviewed} files to review` }
      : undefined;
    void updateEditorContext();
  };

  /** The review file in the focused editor (single diff, multi-diff, or plain). */
  const activeFile = (): ReviewFile | undefined => {
    const editor = vscode.window.activeTextEditor;
    const fromEditor = editor && controller.fileForUri(editor.document.uri);
    if (fromEditor) return fromEditor;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return controller.fileForUri(input.modified) ?? controller.fileForUri(input.original);
    if (input instanceof vscode.TabInputText) return controller.fileForUri(input.uri);
    return undefined;
  };
  const activeDiffIsSinceReview = (): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && controller.isSnapshotSide(input.original);
  };
  const updateEditorContext = async () => {
    const file = controller.active ? activeFile() : undefined;
    await vscode.commands.executeCommand("setContext", "incrementalDiff.activeFile", !!file);
    await vscode.commands.executeCommand("setContext", "incrementalDiff.activeFileChanged", file?.review === "changed");
  };

  const fileArgument = (argument: unknown): ReviewFile | undefined => {
    if (typeof argument === "string") return controller.file(argument);
    const node = argument as TreeNode | undefined;
    if (node?.kind === "file") return controller.file(node.file.path);
    return undefined;
  };

  const run = (command: string, callback: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try {
        await callback(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    });

  const requireActive = () => {
    if (!controller.active) throw new Error("No review is open. Run Incremental Diff: Open Diff… or Open Branch Changes first.");
  };

  const open = async (request: OpenRequest) => {
    const folder = await pickFolder();
    if (!folder) return;
    await vscode.window.withProgress({ location: { viewId: "incrementalDiff.files" } }, () => controller.open(folder, request));
    if ("input" in request) await store.addHistory(request.input);
    await vscode.commands.executeCommand("incrementalDiff.files.focus");
  };

  const openMulti = async (kind: MultiDiffKind) => {
    requireActive();
    const count = await controller.openMulti(kind);
    if (count === 0) {
      void vscode.window.showInformationMessage(kind === "all" ? "No changes." : kind === "unreviewed" ? "Every file is reviewed." : "No file changed since it was reviewed.");
    }
  };

  context.subscriptions.push(
    controller,
    tree,
    view,
    vscode.workspace.registerTextDocumentContentProvider(contentScheme, new BlobContentProvider()),
    vscode.window.registerFileDecorationProvider(new FileDecorations()),
    controller.onDidChange(updateView),
    vscode.window.onDidChangeActiveTextEditor(() => void updateEditorContext()),
    vscode.window.tabGroups.onDidChangeTabs(() => void updateEditorContext()),
    view.onDidChangeCheckboxState(async event => {
      const { reviewed, unreviewed } = checkboxChanges(event.items);
      try {
        await controller.setReviewed(reviewed, true);
        await controller.setReviewed(unreviewed, false);
      } catch (error) {
        void vscode.window.showErrorMessage(`Incremental Diff: ${error instanceof Error ? error.message : error}`);
      } finally {
        // The view toggled the box already; make it match the stored state.
        tree.reload();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("incrementalDiff.viewMode")) {
        void setModeContext();
        tree.reload();
      }
    }),

    run("incrementalDiff.openDiff", async (input?: unknown) => {
      const value = typeof input === "string" ? input : await promptDiffArgs(store);
      if (value !== undefined) await open({ input: value });
    }),
    run("incrementalDiff.openBranchChanges", () => open({ branch: true })),
    run("incrementalDiff.openAllChanges", () => openMulti("all")),
    run("incrementalDiff.openUnreviewedChanges", () => openMulti("unreviewed")),
    run("incrementalDiff.openChangesSinceReview", () => openMulti("since")),
    run("incrementalDiff.refresh", async () => {
      requireActive();
      await vscode.window.withProgress({ location: { viewId: "incrementalDiff.files" } }, () => controller.refresh());
    }),
    run("incrementalDiff.closeReview", () => controller.close()),
    run("incrementalDiff.clearReviewed", async () => {
      requireActive();
      const answer = await vscode.window.showWarningMessage("Clear every reviewed mark of this review?", { modal: true }, "Clear");
      if (answer === "Clear") await controller.clearReviewed();
    }),
    run("incrementalDiff.markReviewedAndNext", async (argument?: unknown) => {
      requireActive();
      // From the tree a node is passed; from an editor title, the editor's URI.
      const fromTree = fileArgument(argument);
      const file = fromTree ?? activeFile() ?? (argument instanceof vscode.Uri ? controller.fileForUri(argument) : undefined);
      if (!file) throw new Error("The focused editor does not show a file of this review.");
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const inSingleDiff = input instanceof vscode.TabInputTextDiff;
      await controller.setReviewed([file.path], true);
      // In the multi-diff editor every file is already on screen; only a single
      // diff (or the tree) moves on to the next file.
      if (!inSingleDiff && !fromTree) return;
      const next = controller.next(file.path);
      if (next) await controller.openFile(next, "auto");
      else void vscode.window.showInformationMessage("Every file is reviewed.");
    }),
    run("incrementalDiff.toggleChangesSinceReview", async () => {
      requireActive();
      const file = activeFile();
      if (!file) throw new Error("The focused editor does not show a file of this review.");
      if (file.review !== "changed") throw new Error(`${file.path} has not changed since it was reviewed.`);
      await controller.openFile(file, activeDiffIsSinceReview() ? "full" : "since");
    }),
    run("incrementalDiff.openFileDiff", async (argument: unknown) => {
      const file = fileArgument(argument);
      if (file) await controller.openFile(file, "auto");
    }),
    run("incrementalDiff.openFullDiff", async (argument: unknown) => {
      const file = fileArgument(argument) ?? activeFile();
      if (file) await controller.openFile(file, "full");
    }),
    run("incrementalDiff.openFileChangesSinceReview", async (argument: unknown) => {
      const file = fileArgument(argument) ?? activeFile();
      if (file) await controller.openFile(file, "since");
    }),
    run("incrementalDiff.openFile", async (argument: unknown) => {
      const file = fileArgument(argument);
      if (!file) return;
      if (file.status === "D") throw new Error(`${file.path} was deleted.`);
      await vscode.window.showTextDocument(controller.uris(file).label);
    }),
    run("incrementalDiff.viewAsTree", () => setMode("tree")),
    run("incrementalDiff.viewAsList", () => setMode("flat"))
  );

  await setModeContext();
  await vscode.commands.executeCommand("setContext", "incrementalDiff.active", false);
  updateView();

  // Reopen the review that was open before the window reloaded.
  const previous = store.session();
  const folder = previous && vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === previous.folder);
  if (previous && folder) {
    controller.open(folder, previous.branch ? { branch: true } : { input: previous.input ?? "" })
      .catch(error => void vscode.window.showWarningMessage(`Incremental Diff could not reopen the previous review: ${error instanceof Error ? error.message : error}`));
  }

  return { controller };
}

async function setMode(mode: "tree" | "flat"): Promise<void> {
  await vscode.workspace.getConfiguration("incrementalDiff").update("viewMode", mode, vscode.ConfigurationTarget.Global);
}

async function setModeContext(): Promise<void> {
  const mode = vscode.workspace.getConfiguration("incrementalDiff").get<string>("viewMode", "tree");
  await vscode.commands.executeCommand("setContext", "incrementalDiff.viewMode", mode);
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error("Open a folder to review its changes.");
  if (folders.length === 1) return folders[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  const preferred = active && vscode.workspace.getWorkspaceFolder(active);
  const items = folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder }));
  if (preferred) items.sort((a, b) => Number(b.folder === preferred) - Number(a.folder === preferred));
  return (await vscode.window.showQuickPick(items, { placeHolder: "Folder to review" }))?.folder;
}

interface ArgsItem extends vscode.QuickPickItem {
  value: string;
}

const removeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("close"), tooltip: "Remove from History" };

/** Asks for `git diff` arguments, offering recent inputs. */
function promptDiffArgs(store: ReviewStateStore): Promise<string | undefined> {
  return new Promise(resolve => {
    const pick = vscode.window.createQuickPick<ArgsItem>();
    pick.title = "Incremental Diff: Open Diff";
    pick.placeholder = "git diff arguments, e.g. main...HEAD, HEAD~3, --cached, A..B -- src (empty: unstaged changes)";
    pick.matchOnDescription = true;
    const describe = (value: string) => value === "" ? "Unstaged changes (git diff)" : `git diff ${value}`;
    const update = () => {
      const typed = pick.value.trim();
      const history = store.history().filter(item => item !== typed);
      pick.items = [
        { label: typed === "" ? "$(diff) (no arguments)" : `$(diff) ${typed}`, description: describe(typed), value: typed, alwaysShow: true },
        ...(history.length ? [{ label: "Recent", kind: vscode.QuickPickItemKind.Separator, value: "" } as ArgsItem] : []),
        ...history.map(item => ({ label: `$(history) ${item === "" ? "(no arguments)" : item}`, description: describe(item), value: item, buttons: [removeButton] }))
      ];
    };
    let accepted: string | undefined;
    pick.onDidChangeValue(update);
    pick.onDidTriggerItemButton(async event => {
      await store.removeHistory(event.item.value);
      update();
    });
    pick.onDidAccept(() => {
      accepted = pick.selectedItems[0]?.value ?? pick.value.trim();
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve(accepted);
    });
    update();
    pick.show();
  });
}

export function deactivate(): void {}
