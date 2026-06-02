import { App, Notice, Plugin, PluginSettingTab, Setting, MarkdownView, Menu, Editor, FileSystemAdapter } from 'obsidian';
import { RangeSetBuilder, Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { getDictionary, getDefaultConfigLoader, readSettings } from 'cspell-lib';
import type { SpellingDictionaryCollection } from 'cspell-lib';
import { pathToFileURL } from 'url';
import * as path from 'path';
import * as fs from 'fs/promises';

interface CSpellCheckerSettings {
    isEnabled: boolean;
}

const DEFAULT_SETTINGS: CSpellCheckerSettings = {
    isEnabled: true,
};

const spellcheckDecoration = Decoration.mark({ class: "sxjeel-misspelled" });

export default class CSpellCheckerPlugin extends Plugin {
    settings: CSpellCheckerSettings;
    dictionary: SpellingDictionaryCollection | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cspellSettings: any = null;
    configFilePath: string | null = null;
    addWordsDictPath: string | null = null;
    pluginExt: Extension;

    async onload() {
        await this.loadSettings();
        await this.loadCSpellConfig();

        this.pluginExt = ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                plugin: CSpellCheckerPlugin;

                constructor(view: EditorView) {
                    this.plugin = (window as any).cspellCheckerPluginInstance;
                    this.decorations = this.buildDecorations(view);
                }

                update(update: ViewUpdate) {
                    if (update.docChanged || update.viewportChanged) {
                        this.decorations = this.buildDecorations(update.view);
                    }
                }

                buildDecorations(view: EditorView): DecorationSet {
                    const builder = new RangeSetBuilder<Decoration>();
                    if (!this.plugin?.settings.isEnabled || !this.plugin?.dictionary) {
                        return builder.finish();
                    }

                    const wordRegex = /\b[a-zA-Z']+\b/g;
                    for (const { from, to } of view.visibleRanges) {
                        const text = view.state.doc.sliceString(from, to);
                        let match;
                        while ((match = wordRegex.exec(text)) !== null) {
                            const word = match[0];
                            if (word.length > 1 && !this.plugin.dictionary!.has(word)) {
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
            },
            { decorations: v => v.decorations }
        );

        (window as any).cspellCheckerPluginInstance = this;
        this.registerEditorExtension(this.pluginExt);

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

                const suggestions = this.dictionary.suggest(word, { numSuggestions: 5 }).map((s: { word: string }) => s.word);
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
        this.cspellSettings = null;
        this.configFilePath = null;
        this.addWordsDictPath = null;

        if (!this.settings.isEnabled) return;

        const adapter = this.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return;

        const vaultPath = adapter.getBasePath();

        try {
            const loader = getDefaultConfigLoader();
            // searchForConfigFileLocation walks up parent dirs to find cspell.json
            const configURL = await loader.searchForConfigFileLocation(pathToFileURL(vaultPath + '/'));
            if (!configURL) return;

            const configFilePath = configURL.pathname;
            this.configFilePath = configFilePath;
            const settings = await readSettings(configURL);
            this.cspellSettings = settings;

            // Find which dictionary definition is marked as the write target
            const configDir = path.dirname(configFilePath);
            const defs: any[] = settings.dictionaryDefinitions ?? [];
            const addWordsDef = defs.find((d: any) => d.addWords && d.path);
            if (addWordsDef) {
                this.addWordsDictPath = path.resolve(configDir, addWordsDef.path);
            }

            this.dictionary = await getDictionary(settings);
        } catch (e) {
            console.error('cspell-checker: failed to load config', e);
        }
    }

    async addToPersonalDictionary(word: string) {
        if (!this.addWordsDictPath) {
            new Notice('No writable dictionary configured — set addWords: true on a dictionaryDefinition in cspell.json.');
            return;
        }

        const existing = await fs.readFile(this.addWordsDictPath, 'utf8');
        const trimmed = existing.trimEnd();
        await fs.writeFile(this.addWordsDictPath, trimmed + '\n' + word + '\n', 'utf8');

        // Reload so the new word takes effect immediately in the current session
        if (this.cspellSettings) {
            this.dictionary = await getDictionary(this.cspellSettings);
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
            : 'No cspell.json found — place one in the vault or a parent directory.';

        const dicts: string[] = this.plugin.cspellSettings?.dictionaries ?? [];
        const dictLine = dicts.length ? `Dictionaries: ${dicts.join(', ')}` : 'No dictionaries loaded.';

        const writeTarget = this.plugin.addWordsDictPath
            ? `Write target: ${this.plugin.addWordsDictPath}`
            : 'No addWords dictionary configured.';

        new Setting(containerEl)
            .setName('Status')
            .setDesc([configLine, dictLine, writeTarget].join('\n'));

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
