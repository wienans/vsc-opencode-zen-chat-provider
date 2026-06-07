#!/usr/bin/env node
/**
 * dev-mode.js — Strip / restore dev-only code from staged files.
 *
 * Usage:
 *   node scripts/dev-mode.js strip     → backup originals, write clean versions
 *   node scripts/dev-mode.js restore   → restore originals from backup
 *
 * Designed to be called by .githooks/pre-commit (strip) and .githooks/post-commit (restore).
 * Non-dev changes in the same files are preserved; only dev-specific lines are removed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.dev-cache');

// ── Files that contain dev-only code ──────────────────────────────────

const DEV_FILES = ['src/modelRegistry.ts', 'src/extension.ts', '.vscode/launch.json'];

// ── Strip rules (TypeScript) ──────────────────────────────────────────
// Each rule: { find: exact string, replace: string }
// Applied in order; only the first match is replaced per rule.

const TS_RULES = {
  'src/modelRegistry.ts': [
    {
      find: [
        "\t\tconst isDev = process.env.VSCODE_EXTENSION_MODE === 'development' || process.env.OPENCODE_ZEN_DEV === '1';",
        "\t\tconst devPrefix = isDev ? 'dev: ' : '';",
        '\t\tconst modelName = devPrefix + (isGo',
      ].join('\n'),
      replace: '\t\tconst modelName = (isGo',
    },
  ],
  'src/extension.ts': [
    {
      find: [
        "\tconst isDev = process.env.VSCODE_EXTENSION_MODE === 'development' || process.env.OPENCODE_ZEN_DEV === '1';",
        "\toutput.appendLine(`[OpenCode Zen] Dev mode: ${isDev ? 'ON (models prefixed with \"dev: \")' : 'OFF'}`);",
        "",
      ].join('\n'),
      replace: '',
    },
  ],
};

// ── Strip / restore helpers ───────────────────────────────────────────

function stripFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    return false; // file doesn't exist, nothing to do
  }

  let content = fs.readFileSync(abs, 'utf8');

  // Detect line ending style and normalize to \n for matching
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  content = content.replace(/\r\n/g, '\n');

  let modified = false;

  // TypeScript rules
  const rules = TS_RULES[relPath] || [];
  for (const rule of rules) {
    if (content.includes(rule.find)) {
      content = content.replace(rule.find, rule.replace);
      modified = true;
    }
  }

  // launch.json — remove "env" key from first configuration
  if (relPath === '.vscode/launch.json') {
    try {
      const json = JSON.parse(content);
      const configs = json.configurations || [];
      for (const cfg of configs) {
        if (cfg.env && cfg.env.OPENCODE_ZEN_DEV !== undefined) {
          delete cfg.env.OPENCODE_ZEN_DEV;
          // Remove empty env object
          if (Object.keys(cfg.env).length === 0) {
            delete cfg.env;
          }
          modified = true;
        }
      }
      if (modified) {
        content = JSON.stringify(json, null, 2) + '\n';
      }
    } catch {
      // malformed JSON — skip
    }
  }

  if (!modified) {
    return false; // nothing to strip
  }

  // Backup original (before EOL normalization)
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, path.basename(relPath) + '.bak'), fs.readFileSync(abs, 'utf8'), 'utf8');

  // Restore original line ending style before writing
  if (eol === '\r\n') {
    content = content.replace(/\n/g, '\r\n');
  }

  // Write stripped version
  fs.writeFileSync(abs, content, 'utf8');
  return true;
}

function restoreFile(relPath) {
  const abs = path.join(ROOT, relPath);
  const bak = path.join(CACHE_DIR, path.basename(relPath) + '.bak');

  if (!fs.existsSync(bak)) {
    return false; // no backup → nothing to restore
  }

  fs.copyFileSync(bak, abs);
  fs.unlinkSync(bak);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────

const action = process.argv[2];

if (action === 'strip') {
  let count = 0;
  for (const f of DEV_FILES) {
    if (stripFile(f)) {
      count++;
    }
  }
  if (count > 0) {
    console.log(`[dev-mode] Stripped dev code from ${count} file(s)`);
  }
} else if (action === 'restore') {
  let count = 0;
  for (const f of DEV_FILES) {
    if (restoreFile(f)) {
      count++;
    }
  }
  // Clean up cache dir
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  }
  if (count > 0) {
    console.log(`[dev-mode] Restored ${count} file(s)`);
  }
} else {
  console.error('Usage: node scripts/dev-mode.js [strip|restore]');
  process.exit(1);
}
