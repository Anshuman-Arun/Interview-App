#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/*
 * Static enforcement limitations:
 * - This checker inspects checked-in JavaScript/TypeScript syntax. It cannot prove
 *   behavior introduced through eval, generated code, native binaries, or opaque
 *   dependency internals.
 * - The authority check freezes the current durable append API and authoritative
 *   SQLite table names. A newly named persistence write API must be added here
 *   rather than being treated as automatically enforced.
 * - Provider checks reject direct process/filesystem/browser/agent capabilities
 *   and non-disabled tool configuration, but cannot prove what a neutrally named
 *   remote SDK method does internally.
 * - Credential checks follow direct event fields and named domain-schema
 *   composition. Computed/dynamically generated schema keys cannot be proven safe
 *   by static inspection and require separate review.
 */

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SCAN_ROOTS = ["apps", "packages", "workers"];
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "coverage", "dist"]);
const AUTHORIZED_WRITER = "packages/interview-engine/src/session-writer.ts";
const AUTHORIZED_PROVIDER_SESSION_FACTORY = "packages/providers/src/execution.ts";
const AUTHORIZED_PROVIDER_PROPOSAL_ADMISSION = "packages/interview-engine/src/provider-coordinator.ts";
const PERSISTENCE_PREFIX = "packages/persistence/";

const PACKAGE_RULES = new Map([
  ["domain", new Set()],
  ["diagnostics", new Set(["domain"])],
  ["events", new Set(["domain"])],
  ["persistence", new Set(["domain", "events"])],
  ["providers", new Set(["domain"])],
  ["problems", new Set(["domain"])],
  ["verification", new Set(["domain"])],
  ["whiteboard", new Set(["domain"])],
  ["local-compute", new Set(["domain"])],
  ["delivery", new Set(["domain", "events"])],
  ["interview-engine", new Set([
    "domain",
    "events",
    "persistence",
    "providers",
    "problems",
    "delivery",
    "local-compute",
    "verification",
    "whiteboard"
  ])]
]);

const AUTHORITATIVE_APPEND_CALLS = new Set([
  "appendIdempotent",
  "appendEvent",
  "appendEvents",
  "appendSessionEvent",
  "appendSessionEvents"
]);

const BANNED_PROVIDER_MODULES = [
  /^(?:node:)?child_process$/u,
  /^(?:node:)?fs(?:\/promises)?$/u,
  /^(?:node:)?vm$/u,
  /^(?:node:)?worker_threads$/u,
  /(?:^|\/)(?:playwright|playwright-core|puppeteer|puppeteer-core|selenium-webdriver)(?:\/|$)/iu,
  /(?:^|\/)(?:browser-use|browser_use|computer-use|computer_use)(?:\/|$)/iu,
  /(?:^|\/)(?:mcp|agent-runtime|agent_runtime)(?:\/|$)/iu
];

const DANGEROUS_PROVIDER_CALLS = new Set([
  "exec",
  "execFile",
  "spawn",
  "fork",
  "readFile",
  "writeFile",
  "appendFile",
  "rm",
  "unlink",
  "chmod",
  "launch",
  "newPage",
  "executeTool",
  "runTool",
  "invokeTool",
  "useTool",
  "callTool",
  "computerUse"
]);

const TOOL_CONFIGURATION_NAMES = new Set(["tools", "toolchoice"]);
const AGENT_CONFIGURATION_NAMES = new Set([
  "agenttools",
  "computer",
  "computeruse",
  "mcpservers",
  "subagents"
]);

const CREDENTIAL_FIELD_NAMES = new Set([
  "apikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "clienttoken",
  "password",
  "passwd",
  "authorization",
  "authtoken",
  "bearertoken",
  "credential",
  "credentials",
  "secret",
  "secretkey",
  "sessiontoken"
]);

const CREDENTIAL_IDENTIFIER_FRAGMENTS = [
  "apikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "clienttoken",
  "password",
  "authorization",
  "authtoken",
  "bearertoken",
  "credential",
  "secretkey",
  "sessiontoken"
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeName(value) {
  return value.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function looksCredentialField(value) {
  const normalized = normalizeName(value);
  if (CREDENTIAL_FIELD_NAMES.has(normalized)) return true;
  return /^(?:api|access|refresh|client|auth|bearer|session)[a-z0-9]*token$/u.test(normalized);
}

function looksCredentialIdentifier(value) {
  const normalized = normalizeName(value);
  return CREDENTIAL_IDENTIFIER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function parseRoot(args) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--root requires a path");
      root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      root = path.resolve(argument.slice("--root=".length));
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return root;
}

async function collectSourceFiles(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const start = path.join(root, scanRoot);
    try {
      await access(start);
    } catch {
      continue;
    }
    await walkDirectory(start, files);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await walkDirectory(fullPath, files);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
  }
}

function scriptKindFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

async function loadRecords(root, files, violations) {
  const records = [];
  for (const absolutePath of files) {
    const source = await readFile(absolutePath, "utf8");
    const relativePath = toPosix(path.relative(root, absolutePath));
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(absolutePath)
    );
    for (const diagnostic of sourceFile.parseDiagnostics) {
      addViolation(
        violations,
        "PARSE_ERROR",
        relativePath,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      );
    }
    records.push({
      absolutePath,
      relativePath,
      source,
      sourceFile,
      location: locationForRelative(relativePath)
    });
  }
  return records;
}

function locationForRelative(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] === "packages" && parts[1] !== undefined) return { kind: "package", name: parts[1] };
  if (parts[0] === "apps" && parts[1] !== undefined) return { kind: "app", name: parts[1] };
  if (parts[0] === "workers" && parts[1] !== undefined) return { kind: "worker", name: parts[1] };
  return { kind: "other", name: "" };
}

function projectTargetForSpecifier(root, record, specifier) {
  if (specifier.startsWith(".")) {
    const absoluteTarget = path.resolve(path.dirname(record.absolutePath), specifier);
    const relativeTarget = toPosix(path.relative(root, absoluteTarget));
    if (relativeTarget === ".." || relativeTarget.startsWith("../")) return null;
    return locationForRelative(relativeTarget);
  }

  if (specifier.startsWith("packages/") || specifier.startsWith("apps/") || specifier.startsWith("workers/")) {
    return locationForRelative(specifier);
  }

  const scopedMatch = /^@interview-app\/([^/]+)(?:\/|$)/u.exec(specifier);
  if (scopedMatch?.[1] !== undefined) return { kind: "package", name: scopedMatch[1] };
  if (PACKAGE_RULES.has(specifier)) return { kind: "package", name: specifier };
  return null;
}

function extractModuleSpecifiers(sourceFile) {
  const specifiers = new Set();

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression !== undefined
        && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.add(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const firstArgument = node.arguments[0];
      if (firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifiers.add(firstArgument.text);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          specifiers.add(firstArgument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers].sort((left, right) => left.localeCompare(right));
}

function checkDependencies(root, records, violations) {
  const packageNames = new Set(
    records
      .filter((record) => record.location.kind === "package")
      .map((record) => record.location.name)
  );

  for (const packageName of [...packageNames].sort()) {
    if (!PACKAGE_RULES.has(packageName)) {
      addViolation(
        violations,
        "UNMAPPED_PACKAGE",
        "packages/" + packageName,
        "New project packages must declare a frozen dependency direction in the boundary checker."
      );
    }
  }

  const graph = new Map();
  for (const packageName of PACKAGE_RULES.keys()) graph.set(packageName, new Set());

  for (const record of records) {
    if (record.location.kind !== "package") continue;
    const allowed = PACKAGE_RULES.get(record.location.name);

    for (const specifier of extractModuleSpecifiers(record.sourceFile)) {
      const target = projectTargetForSpecifier(root, record, specifier);
      if (target === null) continue;

      if (target.kind === "app") {
        addViolation(
          violations,
          "LOWER_LEVEL_APP_IMPORT",
          record.relativePath,
          "Lower-level package " + record.location.name + " imports app " + target.name + " via " + specifier + "."
        );
        continue;
      }

      if (target.kind !== "package" || target.name === record.location.name) continue;
      graph.get(record.location.name)?.add(target.name);

      if (allowed === undefined || !allowed.has(target.name)) {
        addViolation(
          violations,
          "DEPENDENCY_DIRECTION",
          record.relativePath,
          "Package " + record.location.name + " may not import project package " + target.name + " via " + specifier + "."
        );
      }
    }
  }

  checkDependencyCycles(graph, violations);
}

function checkDependencyCycles(graph, violations) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const reported = new Set();

  function visit(packageName) {
    if (visited.has(packageName)) return;
    if (visiting.has(packageName)) return;

    visiting.add(packageName);
    stack.push(packageName);

    for (const target of graph.get(packageName) ?? []) {
      if (visiting.has(target)) {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target].join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          addViolation(violations, "DEPENDENCY_CYCLE", "packages", "Circular project dependency: " + cycle + ".");
        }
      } else {
        visit(target);
      }
    }

    stack.pop();
    visiting.delete(packageName);
    visited.add(packageName);
  }

  for (const packageName of graph.keys()) visit(packageName);
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)
      && expression.argumentExpression !== undefined
      && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function checkAuthority(records, violations) {
  for (const record of records) {
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name !== null
            && AUTHORITATIVE_APPEND_CALLS.has(name)
            && record.relativePath !== AUTHORIZED_WRITER) {
          addViolation(
            violations,
            "AUTHORITY_APPEND",
            record.relativePath,
            "Authoritative event append call " + name + "() is allowed only inside SessionWriter."
          );
        }
      }

      if (!record.relativePath.startsWith(PERSISTENCE_PREFIX)
          && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:session_events|processed_requests)\b/iu.test(node.text)) {
          addViolation(
            violations,
            "AUTHORITY_SQL_WRITE",
            record.relativePath,
            "Direct mutation of authoritative event/idempotency tables bypasses SessionWriter."
          );
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(record.sourceFile);
  }
}

function isBannedProviderModule(specifier) {
  return BANNED_PROVIDER_MODULES.some((pattern) => pattern.test(specifier));
}

function propertyNameText(name) {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function isDisabledCapabilityValue(expression) {
  if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(expression) && expression.text === "undefined") return true;
  if (ts.isArrayLiteralExpression(expression) && expression.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(expression) && expression.properties.length === 0) return true;
  if (ts.isStringLiteralLike(expression)) {
    const value = expression.text.toLowerCase();
    return value === "none" || value === "off" || value === "disabled";
  }
  return false;
}

function checkProviders(records, violations) {
  for (const record of records) {
    function visitSessionCreation(node) {
      if (ts.isCallExpression(node)
          && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        const name = callName(node.expression);
        if (name === "createSession" && record.relativePath !== AUTHORIZED_PROVIDER_SESSION_FACTORY) {
          addViolation(
            violations,
            "PROVIDER_SESSION_ADMISSION",
            record.relativePath,
            "Direct provider createSession() calls bypass capability, billing, and policy admission."
          );
        }
        if (name === "processProposal" && record.relativePath !== AUTHORIZED_PROVIDER_PROPOSAL_ADMISSION) {
          addViolation(
            violations,
            "PROVIDER_PROPOSAL_ADMISSION",
            record.relativePath,
            "Direct processProposal() calls bypass generation-bound provider orchestration."
          );
        }
      }
      ts.forEachChild(node, visitSessionCreation);
    }
    visitSessionCreation(record.sourceFile);

    if (!record.relativePath.startsWith("packages/providers/")) continue;

    for (const specifier of extractModuleSpecifiers(record.sourceFile)) {
      if (isBannedProviderModule(specifier)) {
        addViolation(
          violations,
          "PROVIDER_TOOL_CAPABILITY",
          record.relativePath,
          "Provider code imports prohibited agent/computer capability module " + specifier + "."
        );
      }
    }

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name !== null && DANGEROUS_PROVIDER_CALLS.has(name)) {
          addViolation(
            violations,
            "PROVIDER_TOOL_EXECUTION",
            record.relativePath,
            "Provider code calls prohibited agent/computer capability " + name + "()."
          );
        }
      }

      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const rawName = propertyNameText(node.name);
        if (rawName !== null) {
          const normalized = normalizeName(rawName);
          const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;

          if (TOOL_CONFIGURATION_NAMES.has(normalized) && !isDisabledCapabilityValue(value)) {
            addViolation(
              violations,
              "PROVIDER_TOOL_CONFIGURATION",
              record.relativePath,
              "Provider tool configuration " + rawName + " must be statically disabled/empty."
            );
          }

          if (AGENT_CONFIGURATION_NAMES.has(normalized) && !isDisabledCapabilityValue(value)) {
            addViolation(
              violations,
              "PROVIDER_AGENT_CONFIGURATION",
              record.relativePath,
              "Provider agent/computer configuration " + rawName + " is prohibited."
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(record.sourceFile);
  }
}

function declarationEntries(records) {
  const entries = new Map();

  for (const record of records) {
    if (record.location.kind !== "package" || record.location.name !== "domain") continue;

    for (const statement of record.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            entries.set(declaration.name.text, declaration.initializer);
          }
        }
      } else if ((ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)
          || ts.isClassDeclaration(statement))
          && statement.name !== undefined) {
        entries.set(statement.name.text, statement);
      }
    }
  }

  return entries;
}

function subtreeHasCredentialField(node) {
  let found = false;

  function visit(current) {
    if (found) return;
    if (ts.isPropertyAssignment(current)
        || ts.isPropertySignature(current)
        || ts.isPropertyDeclaration(current)
        || ts.isShorthandPropertyAssignment(current)
        || ts.isMethodSignature(current)
        || ts.isMethodDeclaration(current)) {
      const name = propertyNameText(current.name);
      if (name !== null && looksCredentialField(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return found;
}

function subtreeReferencesAny(node, names) {
  let found = false;

  function visit(current) {
    if (found) return;
    if (ts.isIdentifier(current) && names.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return found;
}

function credentialBearingDomainDeclarations(records) {
  const declarations = declarationEntries(records);
  const credentialBearing = new Set();

  for (const [name, node] of declarations) {
    if (subtreeHasCredentialField(node)) credentialBearing.add(name);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, node] of declarations) {
      if (!credentialBearing.has(name) && subtreeReferencesAny(node, credentialBearing)) {
        credentialBearing.add(name);
        changed = true;
      }
    }
  }

  return credentialBearing;
}

function checkEventCredentials(root, records, violations) {
  const credentialDeclarations = credentialBearingDomainDeclarations(records);

  for (const record of records) {
    if (!record.relativePath.startsWith("packages/events/")) continue;

    function visit(node) {
      if (ts.isPropertyAssignment(node)
          || ts.isPropertySignature(node)
          || ts.isPropertyDeclaration(node)
          || ts.isShorthandPropertyAssignment(node)
          || ts.isMethodSignature(node)
          || ts.isMethodDeclaration(node)) {
        const name = propertyNameText(node.name);
        if (name !== null && looksCredentialField(name)) {
          addViolation(
            violations,
            "EVENT_CREDENTIAL_FIELD",
            record.relativePath,
            "Credential-looking field " + name + " may not enter event schemas/state."
          );
        }
      }

      if (ts.isImportDeclaration(node)
          && ts.isStringLiteralLike(node.moduleSpecifier)
          && projectTargetForSpecifier(root, record, node.moduleSpecifier.text)?.kind === "package"
          && projectTargetForSpecifier(root, record, node.moduleSpecifier.text)?.name === "domain"
          && node.importClause !== undefined) {
        const bindings = node.importClause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          addViolation(
            violations,
            "EVENT_CREDENTIAL_SCHEMA_OPAQUE_IMPORT",
            record.relativePath,
            "Namespace imports from domain are disallowed in events because credential-bearing schemas cannot be audited by name."
          );
        } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (credentialDeclarations.has(importedName) || looksCredentialIdentifier(importedName)) {
              addViolation(
                violations,
                "EVENT_CREDENTIAL_SCHEMA",
                record.relativePath,
                "Credential-bearing/credential-looking domain declaration " + importedName + " may not be used by events."
              );
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(record.sourceFile);
  }
}

function addViolation(violations, code, file, message) {
  violations.push({ code, file, message });
}

function uniqueSortedViolations(violations) {
  const unique = new Map();
  for (const violation of violations) {
    const key = violation.code + "\0" + violation.file + "\0" + violation.message;
    unique.set(key, violation);
  }
  return [...unique.values()].sort((left, right) =>
    left.file.localeCompare(right.file)
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message)
  );
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const violations = [];
  const files = await collectSourceFiles(root);
  const records = await loadRecords(root, files, violations);

  checkDependencies(root, records, violations);
  checkAuthority(records, violations);
  checkProviders(records, violations);
  checkEventCredentials(root, records, violations);

  const finalViolations = uniqueSortedViolations(violations);
  if (finalViolations.length > 0) {
    process.stderr.write(
      "Architecture boundary check failed with "
        + String(finalViolations.length)
        + " violation(s):\n"
        + finalViolations.map((item) => "- [" + item.code + "] " + item.file + ": " + item.message).join("\n")
        + "\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "Architecture boundary checks passed ("
      + String(records.length)
      + " source files scanned).\n"
  );
}

await main();
