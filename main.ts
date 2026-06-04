import { App, Notice, Plugin, PluginSettingTab, Setting, MarkdownView, Menu, Editor, FileSystemAdapter } from 'obsidian';
import { RangeSetBuilder, Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { getDictionary, clearCachedFiles } from 'cspell-lib';
import type { SpellingDictionaryCollection } from 'cspell-lib';
import * as path from 'path';
import * as fs from 'fs/promises';
import { homedir } from 'os';

interface CSpellCheckerSettings {
    isEnabled: boolean;
}

const DEFAULT_SETTINGS: CSpellCheckerSettings = {
    isEnabled: true,
};

const CONFIG_FILENAMES = ['cspell.json', '.cspell.json', 'cspell.config.json', 'cspell.yaml', 'cspell.yml'];

const spellcheckDecoration = Decoration.mark({ class: "sxjeel-misspelled" });

async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
}

async function findCspellConfig(startDir: string): Promise<string | null> {
    let dir = startDir;
    while (true) {
        for (const name of CONFIG_FILENAMES) {
            const candidate = path.join(dir, name);
            if (await fileExists(candidate)) return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

// Find the en_US trie file in the project's pnpm store or npm node_modules.
// cspell-io reads trie files via plain fs.readFile given an absolute path,
// which avoids the require()-based package resolution that breaks when bundled.
async function findEnUsTrie(projectRoot: string): Promise<string | null> {
    const pnpmStore = path.join(projectRoot, 'node_modules', '.pnpm');
    try {
        const dirs = await fs.readdir(pnpmStore);
        for (const dir of dirs) {
            const m = dir.match(/^@cspell\+(dict-en[_-]us)@/i);
            if (!m) continue;
            const pkgName = m[1]; // e.g. "dict-en_us"
            const pkgDir = path.join(pnpmStore, dir, 'node_modules', '@cspell', pkgName);
            for (const filename of ['en_US.trie.gz', 'en_US.trie', 'en-US.trie.gz']) {
                const p = path.join(pkgDir, filename);
                if (await fileExists(p)) return p;
            }
        }
    } catch { /* no pnpm store */ }

    // Flat npm/yarn install
    for (const pkgName of ['dict-en_us', 'dict-en-us']) {
        for (const filename of ['en_US.trie.gz', 'en_US.trie']) {
            const p = path.join(projectRoot, 'node_modules', '@cspell', pkgName, filename);
            if (await fileExists(p)) return p;
        }
    }

    return null;
}

// Build a CSpellUserSettings-compatible object from the raw cspell.json.
// All dictionary paths are resolved to absolute so cspell-io can read them
// with fs.readFile without going through require() / package resolution.
async function buildSettings(configFilePath: string, rawConfig: any): Promise<any> {
    const projectRoot = path.dirname(configFilePath);
    const resolvedDefs: any[] = [];

    for (const def of (rawConfig.dictionaryDefinitions ?? []) as any[]) {
        if (!def.path) {
            resolvedDefs.push(def);
            continue;
        }
        const expanded = (def.path as string).startsWith('~')
            ? path.join(homedir(), (def.path as string).slice(1))
            : def.path as string;
        resolvedDefs.push({ ...def, path: path.resolve(projectRoot, expanded) });
    }

    // If en-us is requested but not explicitly defined, locate the trie
    const dicts: string[] = rawConfig.dictionaries ?? [];
    const enUsEntry = dicts.find(d => /^en[-_]?us$/i.test(d));
    const hasEnUsDef = resolvedDefs.some(d => /^en[-_]?us$/i.test(d.name));

    if (enUsEntry && !hasEnUsDef) {
        const triePath = await findEnUsTrie(projectRoot);
        if (triePath) {
            resolvedDefs.push({ name: enUsEntry, path: triePath });
        }
    }

    return {
        version: '0.2',
        language: rawConfig.language ?? 'en-US',
        caseSensitive: rawConfig.caseSensitive ?? false,
        dictionaries: dicts,
        dictionaryDefinitions: resolvedDefs,
        ignoreWords: rawConfig.ignoreWords,
        words: rawConfig.words,
    };
}

export default class CSpellCheckerPlugin extends Plugin {
    settings: CSpellCheckerSettings;
    dictionary: SpellingDictionaryCollection | null = null;
    configFilePath: string | null = null;
    addWordsDictPath: string | null = null;
    configuredDictNames: string[] = [];
    loadError: string | null = null;
    dictVersion = 0;
    pluginExt: Extension;
    private editorExtensions: Extension[] = [];

    async onload() {
        await this.loadSettings();
        await this.loadCSpellConfig();

        this.pluginExt = ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                plugin: CSpellCheckerPlugin;
                lastDictVersion: number;

                constructor(view: EditorView) {
                    this.plugin = (window as any).cspellCheckerPluginInstance;
                    this.lastDictVersion = this.plugin?.dictVersion ?? 0;
                    this.decorations = this.buildDecorations(view);
                }

                update(update: ViewUpdate) {
                    const currentVersion = this.plugin?.dictVersion ?? 0;
                    if (update.docChanged || update.viewportChanged || currentVersion !== this.lastDictVersion) {
                        this.lastDictVersion = currentVersion;
                        this.decorations = this.buildDecorations(update.view);
                    }
                }

                buildDecorations(view: EditorView): DecorationSet {
                    const builder = new RangeSetBuilder<Decoration>();
                    if (!this.plugin?.settings.isEnabled || !this.plugin?.dictionary) {
                        return builder.finish();
                    }

                    // Extract per-file ignore words from YAML frontmatter and inline directives
                    const doc = view.state.doc;
                    const fullText = doc.sliceString(0, Math.min(doc.length, 2000));
                    const ignoreWords = this.extractIgnoreWords(fullText);

                    const wordRegex = /\b[a-zA-Z']+\b/g;
                    for (const { from, to } of view.visibleRanges) {
                        const text = view.state.doc.sliceString(from, to);
                        let match;
                        while ((match = wordRegex.exec(text)) !== null) {
                            const word = match[0];
                            if (word.length > 1 && !ignoreWords.has(word) && !this.plugin.dictionary!.has(word)) {
                                builder.add(
                                    from + match.index,
                                    from + match.index + word.length,
                                    spellcheckDecoration
                                );
                            }
                        }
                    }
                    return builder.finish();
                }

                extractIgnoreWords(text: string): Set<string> {
                    const words = new Set<string>();

                    // Parse YAML frontmatter: cspell.ignore array or cspell.words array
                    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
                    if (fmMatch) {
                        const fm = fmMatch[1];
                        // Match "cspell:" block with "ignore:" or "words:" list
                        const cspellMatch = fm.match(/^cspell:\s*\n((?:[ \t]+.*\n?)*)/m);
                        if (cspellMatch) {
                            const block = cspellMatch[1];
                            // Extract words from "ignore:" or "words:" lists
                            const listMatch = block.match(/(?:ignore|words):\s*\n((?:\s*-\s+.*\n?)*)/);
                            if (listMatch) {
                                for (const m of listMatch[1].matchAll(/^\s*-\s+(.+)/gm)) {
                                    for (const w of m[1].trim().split(/[\s,]+/)) {
                                        if (w) words.add(w);
                                    }
                                }
                            }
                        }
                        // Also support flat: "cspell: ignore: word1 word2"
                        const flatMatch = fm.match(/^cspell:\s+ignore:\s+(.+)/m);
                        if (flatMatch) {
                            for (const w of flatMatch[1].trim().split(/[\s,]+/)) {
                                if (w) words.add(w);
                            }
                        }
                    }

                    // Also support inline cspell directives anywhere in the scanned text
                    for (const m of text.matchAll(/<!--\s*cspell:\s*ignore[: ]\s*(.+?)-->/gi)) {
                        for (const w of m[1].trim().split(/[\s,]+/)) {
                            if (w) words.add(w);
                        }
                    }

                    return words;
                }
            },
            { decorations: v => v.decorations }
        );

        // Suppress the native browser/OS spell checker so its "Add to dictionary"
        // doesn't appear alongside ours in the context menu.
        const disableNativeSpellcheck = EditorView.contentAttributes.of({ spellcheck: 'false' });

        (window as any).cspellCheckerPluginInstance = this;
        this.editorExtensions.push(this.pluginExt, disableNativeSpellcheck);
        this.registerEditorExtension(this.editorExtensions);
        this.app.workspace.updateOptions();

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
                if (!this.settings.isEnabled || !this.dictionary) return;

                const cursor = editor.getCursor();
                const cm = (editor as any).cm;
                if (!cm?.state) return;

                const pos = editor.posToOffset(cursor);
                const wordRange = cm.state.wordAt(pos);
                if (!wordRange) return;

                const word = cm.state.doc.sliceString(wordRange.from, wordRange.to);
                if (word.length <= 1 || this.dictionary.has(word)) return;

                const fromPos = editor.offsetToPos(wordRange.from);
                const toPos = editor.offsetToPos(wordRange.to);

                menu.addSeparator();

                const suggestions = this.dictionary.suggest(word, { numSuggestions: 5 })
                    .map((s: { word: string }) => s.word);

                if (suggestions.length === 0) {
                    menu.addItem(item => item.setTitle('No suggestions found').setDisabled(true));
                } else {
                    suggestions.forEach((suggestion: string) => {
                        menu.addItem(item => {
                            item.setTitle(`Suggest: ${suggestion}`)
                                .setIcon('check')
                                .onClick(() => editor.replaceRange(suggestion, fromPos, toPos));
                        });
                    });
                }

                menu.addSeparator();
                menu.addItem(item => {
                    item.setTitle(`Add "${word}" to dictionary`)
                        .setIcon('plus-with-circle')
                        .onClick(async () => {
                            await this.addToPersonalDictionary(word);
                            new Notice(`Added "${word}" to dictionary`);
                            this.refreshAllEditors();
                            view.editor.focus();
                        });
                });
            })
        );

        this.addSettingTab(new CSpellCheckerSettingTab(this.app, this));
    }

    onunload() {
        delete (window as any).cspellCheckerPluginInstance;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async loadCSpellConfig() {
        this.dictionary = null;
        this.configFilePath = null;
        this.addWordsDictPath = null;
        this.configuredDictNames = [];
        this.loadError = null;

        if (!this.settings.isEnabled) return;

        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return;

        const vaultPath = adapter.getBasePath();

        try {
            const configFilePath = await findCspellConfig(vaultPath);
            if (!configFilePath) {
                this.loadError = 'No cspell.json found in vault or parent directories.';
                return;
            }
            this.configFilePath = configFilePath;

            const rawConfig = JSON.parse(await fs.readFile(configFilePath, 'utf8'));
            this.configuredDictNames = rawConfig.dictionaries ?? [];

            // Find the first dictionary definition with addWords: true as the write target
            const projectRoot = path.dirname(configFilePath);
            for (const def of (rawConfig.dictionaryDefinitions ?? []) as any[]) {
                if (!def.addWords || !def.path) continue;
                const expanded = (def.path as string).startsWith('~')
                    ? path.join(homedir(), (def.path as string).slice(1))
                    : def.path as string;
                this.addWordsDictPath = path.resolve(projectRoot, expanded);
                break;
            }

            const cspellSettings = await buildSettings(configFilePath, rawConfig);
            this.dictionary = await getDictionary(cspellSettings);

            const errors = this.dictionary.getErrors();
            if (errors.length > 0) {
                console.warn('cspell-checker: dict errors:', errors.map((e: Error) => e.message));
            }
        } catch (e) {
            this.loadError = String(e);
            console.error('cspell-checker: failed to load config', e);
        }
    }

    refreshAllEditors() {
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as any).cm as EditorView | undefined;
                if (cm) {
                    cm.dispatch({});
                }
            }
        });
    }

    async addToPersonalDictionary(word: string) {
        if (!this.addWordsDictPath) {
            new Notice('No writable dictionary configured — set addWords: true on a dictionaryDefinition in cspell.json.');
            return;
        }

        const existing = await fs.readFile(this.addWordsDictPath, 'utf8');
        await fs.writeFile(this.addWordsDictPath, existing.trimEnd() + '\n' + word + '\n', 'utf8');

        // Reload so the new word takes effect immediately
        if (this.configFilePath) {
            await clearCachedFiles();
            const rawConfig = JSON.parse(await fs.readFile(this.configFilePath, 'utf8'));
            const cspellSettings = await buildSettings(this.configFilePath, rawConfig);
            this.dictionary = await getDictionary(cspellSettings);
            this.dictVersion++;
        }
    }
}

class CSpellCheckerSettingTab extends PluginSettingTab {
    plugin: CSpellCheckerPlugin;

    constructor(app: App, plugin: CSpellCheckerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'CSpell Checker' });

        new Setting(containerEl)
            .setName('Enable spell checker')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.isEnabled)
                .onChange(async value => {
                    this.plugin.settings.isEnabled = value;
                    await this.plugin.saveSettings();
                    await this.plugin.loadCSpellConfig();
                    this.plugin.app.workspace.updateOptions();
                    this.display();
                }));

        const configLine = this.plugin.configFilePath
            ? `Config: ${this.plugin.configFilePath}`
            : 'No cspell.json found.';

        const dicts = this.plugin.configuredDictNames;
        const dictLine = dicts.length ? `Dictionaries: ${dicts.join(', ')}` : 'No dictionaries loaded.';

        const writeTarget = this.plugin.addWordsDictPath
            ? `Write target: ${this.plugin.addWordsDictPath}`
            : 'No addWords dictionary configured.';

        const lines = [configLine, dictLine, writeTarget];
        if (this.plugin.loadError) lines.push(`Error: ${this.plugin.loadError}`);

        new Setting(containerEl)
            .setName('Status')
            .setDesc(lines.join('\n'));

        new Setting(containerEl)
            .setName('Reload dictionaries')
            .setDesc('Re-scan for cspell.json and reload all dictionaries.')
            .addButton(btn => btn
                .setButtonText('Reload')
                .setCta()
                .onClick(async () => {
                    await this.plugin.loadCSpellConfig();
                    this.plugin.app.workspace.updateOptions();
                    this.display();
                    new Notice('Dictionaries reloaded!');
                }));
    }
}
