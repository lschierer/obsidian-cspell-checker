import { App, Notice, Plugin, PluginSettingTab, Setting, MarkdownView, Menu, Editor, FileSystemAdapter } from 'obsidian';
import { RangeSetBuilder, Extension } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
// @ts-ignore
import nspell from 'nspell';

interface SpellCheckerSettings {
    isEnabled: boolean;
}

const DEFAULT_SETTINGS: SpellCheckerSettings = {
    isEnabled: true,
}

const spellcheckDecoration = Decoration.mark({ class: "sxjeel-misspelled" });

export default class OfflineSpellChecker extends Plugin {
    settings: SpellCheckerSettings;
    spellcheckers: any[] = [];
    loadedDictNames: string[] = [];
    pluginExt: Extension;

    async onload() {
        await this.loadSettings();
        await this.initDictionaryFiles();
        await this.loadAllDictionaries();

        // 1. CodeMirror Extension for low-resource live highlighting
        this.pluginExt = ViewPlugin.fromClass(
            class {
                decorations: DecorationSet;
                plugin: OfflineSpellChecker;

                constructor(view: EditorView) {
                    this.plugin = (window as any).sxjeelSpellCheckerPluginInstance;
                    this.decorations = this.buildDecorations(view);
                }

                update(update: ViewUpdate) {
                    if (update.docChanged || update.viewportChanged) {
                        this.decorations = this.buildDecorations(update.view);
                    }
                }

                buildDecorations(view: EditorView): DecorationSet {
                    const builder = new RangeSetBuilder<Decoration>();
                    if (!this.plugin || !this.plugin.settings.isEnabled || this.plugin.spellcheckers.length === 0) {
                        return builder.finish();
                    }

                    const wordRegex = /\b[a-zA-Z']+\b/g;

                    for (const { from, to } of view.visibleRanges) {
                        const text = view.state.doc.sliceString(from, to);
                        let match;
                        while ((match = wordRegex.exec(text)) !== null) {
                            const word = match[0];
                            if (word.length > 1) {
                                const isCorrect = this.plugin.spellcheckers.some(sp => sp.correct(word));
                                if (!isCorrect) {
                                    builder.add(from + match.index, from + match.index + word.length, spellcheckDecoration);
                                }
                            }
                        }
                    }
                    return builder.finish();
                }
            },
            { decorations: v => v.decorations }
        );

        (window as any).sxjeelSpellCheckerPluginInstance = this;
        this.registerEditorExtension(this.pluginExt);

        // 2. Right-Click Context Menu (UPDATED FOR MODERN OBSIDIAN ENGINE)
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
                if (!this.settings.isEnabled || this.spellcheckers.length === 0) return;

                const cursor = editor.getCursor();
                const cm = (editor as any).cm;
                
                // Ensure the modern CodeMirror instance is active
                if (!cm || !cm.state) return;

                // Find the exact boundaries of the word under the cursor
                const pos = editor.posToOffset(cursor);
                const wordRange = cm.state.wordAt(pos);
                
                if (!wordRange) return;

                // Extract the clean word and its exact positions
                const word = cm.state.doc.sliceString(wordRange.from, wordRange.to);
                const fromPos = editor.offsetToPos(wordRange.from);
                const toPos = editor.offsetToPos(wordRange.to);

                if (word.length > 1) {
                    const isCorrect = this.spellcheckers.some(sp => sp.correct(word));
                    
                    if (!isCorrect) {
                        menu.addSeparator();

                        // Collect suggestions from ALL loaded dictionaries
                        let allSuggestions: string[] = [];
                        this.spellcheckers.forEach(sp => {
                            allSuggestions.push(...sp.suggest(word));
                        });

                        // Remove duplicates and keep only the top 5
                        const uniqueSuggestions = [...new Set(allSuggestions)].slice(0, 5);

                        if (uniqueSuggestions.length === 0) {
                            menu.addItem((item) => {
                                item.setTitle("No suggestions found").setDisabled(true);
                            });
                        } else {
                            uniqueSuggestions.forEach((suggestion: string) => {
                                menu.addItem((item) => {
                                    item.setTitle(`Suggest: ${suggestion}`)
                                        .setIcon('check')
                                        .onClick(() => {
                                            // Replaces the exact bounds of the word
                                            editor.replaceRange(suggestion, fromPos, toPos);
                                        });
                                });
                            });
                        }

                        menu.addSeparator();
                        menu.addItem((item) => {
                            item.setTitle(`Add "${word}" to dictionary`)
                                .setIcon('plus-with-circle')
                                .onClick(async () => {
                                    await this.addToPersonalDictionary(word);
                                    new Notice(`Added "${word}" to dictionary`);
                                    view.editor.focus();
                                });
                        });
                    }
                }
            })
        );

        this.addSettingTab(new SpellCheckerSettingTab(this.app, this));
    }

    onunload() {
        delete (window as any).sxjeelSpellCheckerPluginInstance;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        (this.app.workspace as any).updateOptions?.(); 
    }

    async initDictionaryFiles() {
        const adapter = this.app.vault.adapter;
        const dictDir = `${this.manifest.dir}/dicts`;
        
        if (!(await adapter.exists(dictDir))) {
            await adapter.mkdir(dictDir);
        }

        const personalDictPath = `${dictDir}/personal.txt`;
        if (!(await adapter.exists(personalDictPath))) {
            await adapter.write(personalDictPath, "");
        }
    }

    async loadAllDictionaries() {
        this.spellcheckers = [];
        this.loadedDictNames = [];
        
        if (!this.settings.isEnabled) return;

        const adapter = this.app.vault.adapter;
        const dictDir = `${this.manifest.dir}/dicts`;

        try {
            const files = await adapter.list(dictDir);
            const affFiles = files.files.filter(f => f.endsWith('.aff'));

            for (const affPath of affFiles) {
                const baseName = affPath.replace('.aff', '');
                const dicPath = `${baseName}.dic`;

                if (files.files.includes(dicPath)) {
                    try {
                        const affFile = await adapter.read(affPath);
                        const dicFile = await adapter.read(dicPath);
                        
                        const sp = nspell(affFile, dicFile);
                        this.spellcheckers.push(sp);
                        
                        const fileName = baseName.split('/').pop();
                        if (fileName) this.loadedDictNames.push(fileName);

                    } catch (err) {
                        console.error(`Failed to load dictionary: ${baseName}`, err);
                    }
                }
            }

            const personalDictPath = `${dictDir}/personal.txt`;
            if (await adapter.exists(personalDictPath)) {
                const personalWords = await adapter.read(personalDictPath);
                if (personalWords) {
                    this.spellcheckers.forEach(sp => sp.personal(personalWords));
                }
            }

            if (this.loadedDictNames.length > 0) {
                console.log(`Spell Checker Loaded: ${this.loadedDictNames.join(', ')}`);
            }

        } catch (e) {
            console.error("Error reading dictionaries folder", e);
        }
    }

    async addToPersonalDictionary(word: string) {
        if (this.spellcheckers.length === 0) return;
        
        const adapter = this.app.vault.adapter;
        const personalDictPath = `${this.manifest.dir}/dicts/personal.txt`;
        
        const existingWords = await adapter.read(personalDictPath);
        const newWords = existingWords ? `${existingWords}\n${word}` : word;
        
        await adapter.write(personalDictPath, newWords);
        
        this.spellcheckers.forEach(sp => sp.add(word)); 
    }
}

class SpellCheckerSettingTab extends PluginSettingTab {
    plugin: OfflineSpellChecker;

    constructor(app: App, plugin: OfflineSpellChecker) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Offline Spell Checker by sxjeel' });

        new Setting(containerEl)
            .setName('Enable Spell Checker')
            .setDesc('Toggle offline spell checking.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.isEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.isEnabled = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        await this.plugin.loadAllDictionaries();
                    } else {
                        this.plugin.spellcheckers = [];
                    }
                    this.plugin.app.workspace.updateOptions();
                    this.display(); 
                }));

        const loadedText = this.plugin.loadedDictNames.length > 0 
            ? `Currently Loaded: ${this.plugin.loadedDictNames.join(', ')}` 
            : `No dictionaries loaded.`;

        new Setting(containerEl)
            .setName('Manage Dictionaries')
            .setDesc(`Drop any .dic and .aff files here. ${loadedText}`)
            .addButton(btn => btn
                .setButtonText('Open Folder')
                .onClick(async () => {
                    const adapter = this.plugin.app.vault.adapter;
                    if (adapter instanceof FileSystemAdapter) {
                        const fullPath = adapter.getFullPath(`${this.plugin.manifest.dir}/dicts`);
                        try {
                            const { shell } = require('electron');
                            shell.openPath(fullPath);
                        } catch (e) {
                            new Notice("Opening the folder directly is only supported on the Desktop app.");
                        }
                    }
                }))
            .addButton(btn => btn
                .setButtonText('Reload Files')
                .setCta()
                .onClick(async () => {
                    await this.plugin.loadAllDictionaries();
                    this.plugin.app.workspace.updateOptions();
                    this.display(); 
                    new Notice("Dictionaries reloaded!");
                }));
    }
}