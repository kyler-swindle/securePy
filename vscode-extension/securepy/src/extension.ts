import * as vscode from "vscode";
import * as path from "path";
import { execFile, ExecFileException } from "child_process";

type SecurePyIssue = {
  filename?: string;
  file?: string;
  path?: string;
  file_path?: string;
  line?: number;
  line_number?: number;
  column?: number | null;
  col?: number | null;
  message?: string;
  issue_text?: string;
  title?: string;
  severity?: string;
  confidence?: string;
  test_id?: string;
  rule_id?: string;
  remediation?: string;
};

type SecurePyJson = {
  issues?: SecurePyIssue[];
  results?: SecurePyIssue[];
  findings?: SecurePyIssue[];
};

let outputChannel: vscode.OutputChannel;
let diagnosticCollection: vscode.DiagnosticCollection;

class SecurePyQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== "SecurePy") {
        continue;
      }

      const code = getDiagnosticCode(diagnostic);

      switch (code) {
        case "debug_mode":
        case "flask_debug_true":
          actions.push(createDebugFalseFix(document, diagnostic));
          break;

        case "unsafe_yaml_load":
        case "yaml_load":
          actions.push(createYamlSafeLoadFix(document, diagnostic));
          break;

        default:
          actions.push(createShowRuleHelpAction(code, diagnostic));
          break;
      }
    }

    return actions;
  }
}

function getDiagnosticCode(diagnostic: vscode.Diagnostic): string {
  if (typeof diagnostic.code === "string") {
    return diagnostic.code;
  }

  if (
    diagnostic.code &&
    typeof diagnostic.code === "object" &&
    "value" in diagnostic.code
  ) {
    return String(diagnostic.code.value);
  }

  return "securepy";
}

function createDebugFalseFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    "Change debug=True to debug=False",
    vscode.CodeActionKind.QuickFix
  );

  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  const line = document.lineAt(diagnostic.range.start.line);
  if (!line.text.includes("debug=True")) {
    return action;
  }

  const newLine = line.text.replace("debug=True", "debug=False");

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, line.range, newLine);
  action.edit = edit;

  return action;
}

function createYamlSafeLoadFix(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    "Replace yaml.load with yaml.safe_load",
    vscode.CodeActionKind.QuickFix
  );

  action.diagnostics = [diagnostic];
  action.isPreferred = true;

  const line = document.lineAt(diagnostic.range.start.line);
  if (!line.text.includes("yaml.load")) {
    return action;
  }

  const newLine = line.text.replace("yaml.load", "yaml.safe_load");

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, line.range, newLine);
  action.edit = edit;

  return action;
}

function createShowRuleHelpAction(
  code: string,
  diagnostic: vscode.Diagnostic
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    `SecurePy: Explain rule "${code}"`,
    vscode.CodeActionKind.QuickFix
  );

  action.diagnostics = [diagnostic];
  action.command = {
    command: "securepy.explainRule",
    title: "Explain SecurePy rule",
    arguments: [code]
  };

  return action;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("SecurePy");
  diagnosticCollection = vscode.languages.createDiagnosticCollection("securepy");

  const scanFileCommand = vscode.commands.registerCommand("securepy.scanFile", async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showErrorMessage("No active file open.");
      return;
    }

    const document = editor.document;

    if (document.isUntitled) {
      vscode.window.showErrorMessage("Please save the file before scanning.");
      return;
    }

    if (!isPythonDocument(document)) {
      vscode.window.showWarningMessage("SecurePy only scans Python files.");
      return;
    }

    await runSecurePyScan([document.fileName], getScanCwdForDocument(document));
  });

  const scanWorkspaceCommand = vscode.commands.registerCommand("securepy.scanWorkspace", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder is open.");
      return;
    }

    await runSecurePyScan([workspaceFolder.uri.fsPath], workspaceFolder.uri.fsPath);
  });

  const clearDiagnosticsCommand = vscode.commands.registerCommand("securepy.clearDiagnostics", () => {
    diagnosticCollection.clear();
    outputChannel.appendLine("SecurePy diagnostics cleared.");
    vscode.window.showInformationMessage("SecurePy diagnostics cleared.");
  });

  const explainRuleCommand = vscode.commands.registerCommand("securepy.explainRule", async (code: string) => {
    vscode.window.showInformationMessage(
      `SecurePy rule: ${code}. Add richer rule documentation or a docs URL here later.`
    );
  });

  const quickFixProvider = vscode.languages.registerCodeActionsProvider(
    { language: "python", scheme: "file" },
    new SecurePyQuickFixProvider(),
    {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }
  );

  const scanOnSaveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    const config = vscode.workspace.getConfiguration();
    const scanOnSave = config.get<boolean>("securepy.scanOnSave", false);

    if (!scanOnSave) {
      return;
    }

    if (!isPythonDocument(document)) {
      return;
    }

    if (document.isUntitled) {
      return;
    }

    outputChannel.appendLine(`Scan-on-save triggered for: ${document.fileName}`);
    await runSecurePyScan([document.fileName], getScanCwdForDocument(document), false);
  });

  context.subscriptions.push(
    scanFileCommand,
    scanWorkspaceCommand,
    clearDiagnosticsCommand,
    explainRuleCommand,
    quickFixProvider,
    scanOnSaveDisposable,
    outputChannel,
    diagnosticCollection
  );
}

export function deactivate() {}

async function runSecurePyScan(
  targets: string[],
  cwd?: string,
  showOutput: boolean = true
): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const configuredExecutablePath = (config.get<string>("securepy.executablePath", "") ?? "").trim();
  const extraArgs = config.get<string[]>("securepy.scanArgs", [
    "--format",
    "json",
    "--stdout",
    "--no-color"
  ]);

  const attempts = buildSecurePyAttempts(targets, extraArgs, configuredExecutablePath, cwd);

  outputChannel.clear();
  if (showOutput) {
    outputChannel.show(true);
  }

  let combinedErrors = "";

  for (const attempt of attempts) {
    outputChannel.appendLine(`Running: ${attempt.command} ${attempt.args.join(" ")}`);
    outputChannel.appendLine("");

    const result = await execFileAsync(attempt.command, attempt.args, cwd);

    if (result.stderr.trim()) {
      outputChannel.appendLine("stderr:");
      outputChannel.appendLine(result.stderr);
      outputChannel.appendLine("");
    }

    if (result.error) {
      combinedErrors += `[${attempt.command}] ${result.error.message}\n`;
      if (result.stderr.trim()) {
        combinedErrors += `${result.stderr}\n`;
      }

      outputChannel.appendLine(`Attempt failed: ${result.error.message}`);
      outputChannel.appendLine("");

      if (shouldTryNextAttempt(result.error, result.stderr)) {
        continue;
      }

      vscode.window.showErrorMessage(`SecurePy failed: ${result.error.message}`);
      return;
    }

    const stdout = result.stdout ?? "";

    if (!stdout.trim()) {
      combinedErrors += `[${attempt.command}] No output returned.\n`;
      outputChannel.appendLine("No JSON output received from SecurePy.");
      outputChannel.appendLine("");

      continue;
    }

    outputChannel.appendLine("stdout:");
    outputChannel.appendLine(stdout);
    outputChannel.appendLine("");

    try {
      const parsed = JSON.parse(stdout) as SecurePyJson;
      applyDiagnostics(parsed);

      if (showOutput) {
        vscode.window.showInformationMessage("SecurePy scan complete.");
      }
      return;
    } catch (parseError) {
      combinedErrors += `[${attempt.command}] JSON parse failed: ${String(parseError)}\n`;
      outputChannel.appendLine("Failed to parse SecurePy JSON output.");
      outputChannel.appendLine(String(parseError));
      outputChannel.appendLine("");

      continue;
    }
  }

  outputChannel.appendLine("All SecurePy launch attempts failed.");
  if (combinedErrors.trim()) {
    outputChannel.appendLine(combinedErrors);
  }

  vscode.window.showErrorMessage(
    "SecurePy could not be launched. Install it into your active Python interpreter with 'python -m pip install securepy', or set 'securepy.executablePath' in VS Code settings."
  );
}

type SecurePyAttempt = {
  command: string;
  args: string[];
};

function buildSecurePyAttempts(
  targets: string[],
  extraArgs: string[],
  configuredExecutablePath: string,
  cwd?: string
): SecurePyAttempt[] {
  const attempts: SecurePyAttempt[] = [];
  const seen = new Set<string>();

  const directArgs = ["scan", ...targets, ...extraArgs];
  const moduleArgs = ["-m", "securepy", "scan", ...targets, ...extraArgs];

  if (configuredExecutablePath) {
    pushAttempt(attempts, seen, configuredExecutablePath, directArgs);
  }

  for (const interpreter of getPythonInterpreterCandidates(cwd)) {
    pushAttempt(attempts, seen, interpreter, moduleArgs);
  }

  return attempts;
}

function pushAttempt(
  attempts: SecurePyAttempt[],
  seen: Set<string>,
  command: string,
  args: string[]
): void {
  const trimmed = command.trim();
  if (!trimmed) {
    return;
  }

  const key = `${trimmed}::${args.join("\u0000")}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  attempts.push({ command: trimmed, args });
}

function getPythonInterpreterCandidates(cwd?: string): string[] {
  const pythonConfig = vscode.workspace.getConfiguration("python");
  const workspaceFolder = getWorkspaceFolderForCwd(cwd);

  const configuredInterpreter = resolveInterpreterPath(
    pythonConfig.get<string>("defaultInterpreterPath", ""),
    workspaceFolder
  );

  const legacyInterpreter = resolveInterpreterPath(
    pythonConfig.get<string>("pythonPath", ""),
    workspaceFolder
  );

  const localVenvs = getLocalVenvCandidates(workspaceFolder);
  const activeVenv = getActiveVenvPython();

  return [
    configuredInterpreter,
    legacyInterpreter,
    ...localVenvs,
    activeVenv,
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python"
  ].filter((value, index, array) => value && array.indexOf(value) === index);
}

function getWorkspaceFolderForCwd(cwd?: string): string | undefined {
  if (cwd) {
    return cwd;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function resolveInterpreterPath(rawPath: string, workspaceFolder?: string): string {
  const value = (rawPath ?? "").trim();
  if (!value) {
    return "";
  }

  if (workspaceFolder) {
    return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
  }

  return value;
}

function getLocalVenvCandidates(workspaceFolder?: string): string[] {
  if (!workspaceFolder) {
    return [];
  }

  const candidates: string[] = [];

  if (process.platform === "win32") {
    candidates.push(
      path.join(workspaceFolder, ".venv", "Scripts", "python.exe"),
      path.join(workspaceFolder, "venv", "Scripts", "python.exe")
    );
  } else {
    candidates.push(
      path.join(workspaceFolder, ".venv", "bin", "python"),
      path.join(workspaceFolder, "venv", "bin", "python")
    );
  }

  return candidates;
}

function execFileAsync(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; error: ExecFileException | null }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8"
      },
      (
        error: ExecFileException | null,
        stdout: string,
        stderr: string
      ) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error
        });
      }
    );
  });
}

function getActiveVenvPython(): string {
  const venv = process.env.VIRTUAL_ENV?.trim();
  if (!venv) {
    return "";
  }

  if (process.platform === "win32") {
    return path.join(venv, "Scripts", "python.exe");
  }

  return path.join(venv, "bin", "python");
}

function shouldTryNextAttempt(error: ExecFileException, stderr: string): boolean {
  const code = error.code;
  const combined = `${error.message}\n${stderr}`.toLowerCase();

  if (code === "ENOENT") {
    return true;
  }

  if (combined.includes("no module named securepy")) {
    return true;
  }

  if (combined.includes("dataclass() got an unexpected keyword argument 'slots'")) {
    return true;
  }

  if (combined.includes("module named securepy")) {
    return true;
  }

  return false;
}

async function applyDiagnostics(data: SecurePyJson): Promise<void> {
  diagnosticCollection.clear();

  const issues = data.findings ?? data.issues ?? data.results ?? [];
  const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

  for (const issue of issues) {
    const filePath = issue.file_path ?? issue.filename ?? issue.file ?? issue.path;
    if (!filePath) {
      continue;
    }

    const line = Math.max((issue.line ?? issue.line_number ?? 1) - 1, 0);
    const rawCol = issue.column ?? issue.col ?? 1;
    const col = Math.max((rawCol ?? 1) - 1, 0);

    const messageParts: string[] = [];

    if (issue.title) {
      messageParts.push(issue.title);
    }

    if (issue.message) {
      messageParts.push(issue.message);
    }

    if (issue.remediation) {
      messageParts.push(`Remediation: ${issue.remediation}`);
    }

    const message = messageParts.join(" ") || "SecurePy reported an issue.";
    const code = issue.test_id ?? issue.rule_id ?? "securepy";
    const severity = mapSeverity(issue.severity);

    const uri = vscode.Uri.file(filePath);
    const range = await buildDiagnosticRange(uri, line, col, issue.column ?? issue.col ?? null);

    const diagnostic = new vscode.Diagnostic(
      range,
      `${message} [${code}]`,
      severity
    );

    diagnostic.source = "SecurePy";
    diagnostic.code = code;

    const existing = diagnosticsByFile.get(filePath) ?? [];
    existing.push(diagnostic);
    diagnosticsByFile.set(filePath, existing);
  }

  for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
    diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
  }

  outputChannel.appendLine(`Applied ${issues.length} diagnostic(s).`);
}

async function buildDiagnosticRange(
  uri: vscode.Uri,
  line: number,
  col: number,
  rawColumn: number | null
): Promise<vscode.Range> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);

    const safeLine = Math.min(line, Math.max(document.lineCount - 1, 0));
    const lineText = document.lineAt(safeLine).text;

    if (rawColumn === null || rawColumn === undefined) {
      return new vscode.Range(
        new vscode.Position(safeLine, 0),
        new vscode.Position(safeLine, Math.max(lineText.length, 1))
      );
    }

    const safeCol = Math.min(col, Math.max(lineText.length, 0));

    const tokenMatch = lineText.slice(safeCol).match(/^[A-Za-z_][A-Za-z0-9_.=()'", ]*/);
    const tokenLength = tokenMatch ? tokenMatch[0].length : 1;
    const endCol = Math.min(safeCol + Math.max(tokenLength, 1), Math.max(lineText.length, 1));

    return new vscode.Range(
      new vscode.Position(safeLine, safeCol),
      new vscode.Position(safeLine, endCol)
    );
  } catch {
    return new vscode.Range(
      new vscode.Position(line, col),
      new vscode.Position(line, col + 1)
    );
  }
}

function mapSeverity(severity?: string): vscode.DiagnosticSeverity {
  switch ((severity ?? "").toLowerCase()) {
    case "high":
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "low":
    case "info":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

function isPythonDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "python" || document.fileName.endsWith(".py");
}

function getScanCwdForDocument(document: vscode.TextDocument): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  return workspaceFolder?.uri.fsPath;
}