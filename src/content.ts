import * as vscode from "vscode";
import { git } from "./git";

/** Read-only documents holding a git blob (snapshots) or nothing (empty sides). */
export const contentScheme = "incremental-diff";

export type ContentSide = "left" | "right" | "snapshot";

interface ContentQuery {
  root: string;
  /** Blob id; empty for an empty document. */
  blob: string;
  side: ContentSide;
}

/** A URI whose path is the file's own path, so language and icons match. */
export function blobUri(fileUri: vscode.Uri, root: string, blob: string | undefined, side: ContentSide): vscode.Uri {
  const query: ContentQuery = { root, blob: blob ?? "", side };
  return fileUri.with({ scheme: contentScheme, query: JSON.stringify(query) });
}

export function contentSide(uri: vscode.Uri): ContentSide | undefined {
  if (uri.scheme !== contentScheme) return undefined;
  try {
    return (JSON.parse(uri.query) as ContentQuery).side;
  } catch {
    return undefined;
  }
}

export class BlobContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = JSON.parse(uri.query) as ContentQuery;
    if (!query.blob) return "";
    return git(query.root, ["cat-file", "blob", query.blob]);
  }
}
