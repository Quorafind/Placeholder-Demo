import { App, debounce, Debouncer, MarkdownView, Plugin, PluginSettingTab, Setting, SettingTab } from 'obsidian';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { cloneDeep } from "lodash";
import { combineConfig, Compartment, Extension, Facet, StateEffect } from "@codemirror/state";

export type Options = {
	placeHolderDelay: number;
	placeHolderTextLength: number;
	longPlaceholder: string;
	shortPlaceholder: string;
};

const defaultOptions: Options = {
	placeHolderDelay: 200,
	placeHolderTextLength: 40,
	longPlaceholder: 'too long',
	shortPlaceholder: 'not too long',
};

export const MyPluginConfig = Facet.define<Options, Required<Options>>({
	combine(options: readonly Options[]) {
		return combineConfig(options, defaultOptions, {
			placeHolderDelay: Math.min,
			placeHolderTextLength: (a, b) => b || a,
			longPlaceholder: (a, b) => b || a,
			shortPlaceholder: (a, b) => b || a,
		});
	},
});

export const MyCompartment = new Compartment();

export function MyExtension(options?: Options): Extension {
	let ext: Extension[] = [placeHolder];
	if (options) {
		ext.push(MyCompartment.of(MyPluginConfig.of(cloneDeep(options))));
	}
	return ext;
}

export function reconfigureMyExtension(options: Options) {
	return MyCompartment.reconfigure(MyPluginConfig.of(cloneDeep(options)));
}

class PlaceholderWidget extends WidgetType {

	constructor(
		readonly view: EditorView,
		readonly from: number,
		readonly to: number,
		readonly placeholder: string,
		readonly cls: string
	) {
		super();
	}

	eq(other: PlaceholderWidget) {
		return other.view === this.view && other.from === this.from && other.to === this.to && other.placeholder === this.placeholder && other.cls === this.cls;
	}

	toDOM() {
		const span = createEl('span', {
			cls: 'editor-placeholder',
			text: this.placeholder,
			attr: {
				'data-ph': this.cls,
			}
		});

		return span;
	}

	ignoreEvent() {
		return true;
	}
}

// Define a function that creates a placeholder widget for text editing.
// Parameters: view (EditorView), placeholder text, range (from, to), and CSS class (cls)
const placeholderWidget = ({view, placeholder, from, to, cls}: {
	view: EditorView,
	from: number,
	to: number,
	placeholder: string;
	cls: string;
}) => Decoration.widget(
	{
		widget: new PlaceholderWidget(view, from, to, placeholder, cls),
		side: 1,
	}
);

// Create a ViewPlugin that manages decorations (visual placeholders in this context)
const placeHolder = ViewPlugin.fromClass(
	class {
		// Class properties: decorations (DecorationSet), placeholder delay, and a debouncer for delayed decoration calculation
		decorations: DecorationSet;
		placeHolderDelay: number;
		delayedGetDeco: Debouncer<[view: EditorView], any>;

		// Constructor: initializes debouncer and decorations based on the current view
		constructor(view: EditorView) {
			this.updateDebouncer(view);
			this.decorations = this.getDeco(view);
		}

		// Method to update decorations based on changes in the view or document
		update(update: ViewUpdate) {
			// Check if there's a configuration change in the plugin
			let reconfigured = JSON.stringify(update.startState.facet(MyPluginConfig)) !== JSON.stringify(update.state.facet(MyPluginConfig));
			// Trigger decoration update if the document changes, viewport changes, or configuration reconfigures
			if (update.docChanged || update.viewportChanged || reconfigured) {
				this.delayedGetDeco(update.view);
			}
		}

		// Method to update the debouncer with current view settings
		updateDebouncer(view: EditorView) {
			// Set delay from plugin configuration
			this.placeHolderDelay = view.state.facet(MyPluginConfig).placeHolderDelay;
			// Debouncer delays the decoration calculation to improve performance
			this.delayedGetDeco = debounce(
				(view: EditorView) => {
					// Calculate and set new decorations
					this.decorations = this.getDeco(view);
					view.update([]); // Force an update of the view to apply new decorations
				},
				this.placeHolderDelay,
				true
			);
		}

		// Method to calculate and return a set of decorations for the current view
		getDeco(view: EditorView): DecorationSet {
			let conf = view.state.facet(MyPluginConfig);
			const {state} = view;

			let deco = []; // Array to store decorations

			// Loop through each visible range in the view
			for (let part of view.visibleRanges) {
				const {from, to} = part;
				const text = state.sliceDoc(from, to); // Extract text from the document
				// Split text into lines
				const lines = text.split('\n');
				let currentFrom = from;

				// Iterate through each line to create placeholders
				for (let line of lines) {
					// Skip empty lines
					if (line.length === 0) {
						currentFrom += line.length + 1;
						continue;
					}

					const currentTo = currentFrom + line.length;
					// Determine placeholder text based on line length
					const placeholder = line.length > conf.placeHolderTextLength ? conf.longPlaceholder : conf.shortPlaceholder;

					// Create and add a placeholder widget to the decorations array
					deco.push(placeholderWidget({
						view,
						placeholder: placeholder,
						from: currentTo,
						to: currentTo,
						cls: line.length > conf.placeHolderTextLength ? 'long' : 'short',
					}).range(currentTo, currentTo));
					currentFrom += line.length + 1;
				}
			}

			// Return a sorted set of decorations
			return Decoration.set(deco.sort(
				(a, b) => a.from - b.from || a.to - b.to
			));
		}
	},
	{
		decorations: v => v.decorations,
	}
);


export default class ExamplePlugin extends Plugin {
	settingTab: MyPluginSettingTab;
	settings: Options;

	async onload() {
		this.settingTab = new MyPluginSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		await this.loadSettings();

		this.registerEditorExtension(
			[MyExtension(this.settings)]
		);
	}

	onunload() {

	}

	// Iterate through all MarkdownView leaves and execute a callback function on each
	iterateCM6(callback: (editor: EditorView) => unknown) {
		this.app.workspace.iterateAllLeaves(leaf => {
			leaf?.view instanceof MarkdownView &&
			(leaf.view.editor as any)?.cm instanceof EditorView &&
			callback((leaf.view.editor as any).cm);
		});
	}

	updateConfig = debounce(
		(type: string, config: Options) => {
			let reconfigure: (config: Options) => StateEffect<unknown>;
			if (type === 'search') {
				reconfigure = reconfigureMyExtension;
			} else {
				return;
			}
			this.iterateCM6(view => {
				view.dispatch({
					effects: reconfigure(config),
				});
			});
		},
		1000,
		true
	);

	public async loadSettings() {
		this.settings = Object.assign({}, defaultOptions, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateConfig('search', this.settings);
	}

}

class MyPluginSettingTab extends PluginSettingTab {
	plugin: ExamplePlugin;

	constructor(app: App, plugin: ExamplePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	debounceSave = debounce(async () => {
		await this.plugin.saveSettings();
	}, 200, true);

	display(): void {
		let {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Place holder text length")
			.addSlider((number) =>
				number.setDynamicTooltip().setLimits(10, 400, 10).setValue(this.plugin.settings.placeHolderTextLength).onChange(
					value => {
						this.plugin.settings.placeHolderTextLength = value;
						this.debounceSave();
					}
				)
			);

		new Setting(containerEl)
			.setName("Long placeholder")
			.addText(text => text.setValue(this.plugin.settings.longPlaceholder).onChange((value) => {
				this.plugin.settings.longPlaceholder = value;
				this.debounceSave();
			}));

		new Setting(containerEl)
			.setName("Short placeholder")
			.addText(text => text.setValue(this.plugin.settings.shortPlaceholder).onChange((value) => {
				this.plugin.settings.shortPlaceholder = value;
				this.debounceSave();
			}));
	}
}
