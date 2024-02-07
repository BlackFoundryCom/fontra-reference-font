import Panel from "fontra/editor/panel.js";

import { getSelectedGlyphInfo } from "fontra/editor/scene-model.js";
import {
  createDomElement,
  div,
  input,
  label,
  option,
  select,
  span,
} from "fontra/core/html-utils.js";
import { ObservableController } from "fontra/core/observable-object.js";
import { fetchJSON, fileNameExtension, withTimeout } from "fontra/core/utils.js";
import { dialog, message } from "fontra/web-components/modal-dialog.js";
import { UIList } from "fontra/web-components/ui-list.js";
import "fontra/web-components/range-slider.js";
import "fontra/third-party/lib-font/inflate.js";
import "fontra/third-party/lib-font/unbrotli.js";
import { Font } from "fontra/third-party/lib-font.js";

import { registerVisualizationLayerDefinition } from "fontra/editor/visualization-layer-definitions.js";

customElements.define("reference-font-ui-list", UIList);

let referenceFontModel;

const fontFileExtensions = new Set(["ttf", "otf", "woff", "woff2"]);
const DEFAULT_FONT_SIZE = 100;

registerVisualizationLayerDefinition({
  identifier: "fontra.reference.font",
  name: "Reference font",
  selectionMode: "editing",
  userSwitchable: true,
  defaultOn: true,
  zIndex: 100,
  screenParameters: { strokeWidth: 1 },
  colors: { fillColor: "#AAA6" },
  // colorsDarkMode: { strokeColor: "red" },
  draw: (context, positionedGlyph, parameters, model, controller) => {
    if (!referenceFontModel?.referenceFontName) {
      return;
    }
    let text = referenceFontModel?.charOverride || positionedGlyph.character;
    if (!text && positionedGlyph.glyphName.includes(".")) {
      const baseGlyphName = positionedGlyph.glyphName.split(".")[0];
      const codePoint = (editorController.fontController.glyphMap[baseGlyphName] ||
        [])[0];
      if (codePoint) {
        text = String.fromCodePoint(codePoint);
      }
    }
    if (!text) {
      return;
    }
    context.lineWidth = parameters.strokeWidth;
    context.font = `${model.fontController.unitsPerEm}px ${referenceFontModel.referenceFontName}, AdobeBlank`;
    context.scale(1, -1);
    if (parameters.fillColor) {
      context.fillStyle = parameters.fillColor;
      context.fillText(text, 0, 0);
    }
    if (parameters.strokeColor) {
      context.strokeStyle = parameters.strokeColor;
      context.strokeText(text, 0, 0);
    }
  },
});

function cleanFontItems(fontItems) {
  return fontItems.map((fontItem) => {
    return {
      uplodadedFileName: fontItem.uplodadedFileName,
      fontIdentifier: fontItem.fontIdentifier,
    };
  });
}

function readSupportedLanguages(fontItem, languageMapping) {
  return new Promise((resolve, reject) => {
    const font = new Font(fontItem.fontIdentifier, {
      skipStyleSheet: true,
    });
    font.onerror = (event) => {
      console.error("Error when creating Font instance (lib-font).", event);
      resolve([]);
    };
    font.onload = (event) => {
      const font = event.detail.font;
      const getLangs = (table) => {
        if (table) {
          return table
            .getSupportedScripts()
            .reduce((acc, script) => {
              const scriptTable = table.getScriptTable(script);
              return acc.concat(table.getSupportedLangSys(scriptTable));
            }, [])
            .map((lang) => lang.trim());
        } else {
          return [];
        }
      };
      const gsubLangs = getLangs(font.opentype.tables.GSUB);
      const gposLangs = getLangs(font.opentype.tables.GPOS);
      const allLangs = new Set([...gsubLangs, ...gposLangs]);

      const supportedLanguages = [...allLangs]
        .filter((lang) => languageMapping[lang])
        .map((lang) => languageMapping[lang]);
      supportedLanguages.sort((a, b) => a[0].localeCompare(b[0]));
      resolve(supportedLanguages);
    };
    font.src = fontItem.objectURL;
  });
}

async function garbageCollectUnusedFiles(fontItems) {
  const usedFontIdentifiers = new Set(
    fontItems.map((fontItem) => fontItem.fontIdentifier)
  );
  const fileNames = await listFontFileNamesInOPFS();
  for (const fileName of fileNames) {
    if (!usedFontIdentifiers.has(fileName)) {
      // Unused font file
      deleteFontFileFromOPFS(fileName);
    }
  }
}

function garbageCollectFontItem(fontItem) {
  if (fontItem.fontFace) {
    document.fonts.delete(fontItem.fontFace);
  }
  if (fontItem.objectURL) {
    URL.revokeObjectURL(fontItem.objectURL);
  }
}

async function getOPFSFontsDir() {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle("reference-fonts", { create: true });
}

async function listFontFileNamesInOPFS() {
  const fontsDir = await getOPFSFontsDir();
  const fileNames = [];
  for await (const [name, handle] of fontsDir.entries()) {
    fileNames.push(name);
  }
  return fileNames;
}

async function readFontFileFromOPFS(fileName) {
  const fontsDir = await getOPFSFontsDir();
  const fileHandle = await fontsDir.getFileHandle(fileName);
  return await fileHandle.getFile();
}

async function deleteFontFileFromOPFS(fileName) {
  const fontsDir = await getOPFSFontsDir();
  await fontsDir.removeEntry(fileName);
}

let opfsSupportsCreateWritable;

async function writeFontFileToOPFS(fileName, file) {
  if (opfsSupportsCreateWritable == undefined || opfsSupportsCreateWritable === true) {
    const error = await writeFontFileToOPFSAsync(fileName, file);
    if (opfsSupportsCreateWritable == undefined) {
      opfsSupportsCreateWritable = !error;
    }
  }
  if (opfsSupportsCreateWritable === false) {
    await writeFontFileToOPFSInWorker(fileName, file);
  }
}

async function writeFontFileToOPFSAsync(fileName, file) {
  const fontsDir = await getOPFSFontsDir();
  const fileHandle = await fontsDir.getFileHandle(fileName, { create: true });
  if (!fileHandle.createWritable) {
    // This is the case in Safari (as of august 2023)
    return "OPFS does not support fileHandle.createWritable()";
  }
  const writable = await fileHandle.createWritable();
  await writable.write(file);
  await writable.close();
}

let worker;

function getWriteWorker() {
  if (!worker) {
    const path = "/core/opfs-write-worker.js"; // + `?${Math.random()}`;
    worker = new Worker(path);
  }
  return worker;
}

async function writeFontFileToOPFSInWorker(fileName, file) {
  return await withTimeout(
    new Promise((resolve, reject) => {
      const worker = getWriteWorker();
      worker.onmessage = (event) => {
        if (event.data.error) {
          reject(event.data.error);
        } else {
          resolve(event.data.returnValue);
        }
      };
      worker.postMessage({ path: ["reference-fonts", fileName], file });
    }),
    5000
  );
}

export default class ReferenceFontPanel extends Panel {
  identifier = "reference-font-panel";
  iconPath = "/images/reference.svg";

  static styles = `
    .sidebar-reference-font {
      width: 100%;
      height: 100%;
      display: flex;
    }

    #reference-font {
      width: 100%;
      display: grid;
      padding: 1em;
      gap: 1em;
      height: 100%;
      box-sizing: border-box;
      white-space: normal;
      align-content: start;
    }

    .title {
      font-weight: bold;
    }

    input[type="text"] {
      border-radius: 5px;
      min-width: 4em;
      outline: none;
      border: none;
      background-color: var(--text-input-background-color);
      color: var(--text-input-foreground-color);
      padding: 0.4em;
      font-family: fontra-ui-regular;
      font-feature-settings: "tnum" 1;
    }

    .current-character {
      overflow: auto;
    }

    .current-character-font-size {
      width: 100%;
    }

    .reference-font-preview {
      display: grid;
      overflow: auto;
    }
  `;

  constructor(editorController) {
    super(editorController);

    fetchJSON("/editor/language-mapping.json").then((languageMapping) => {
      this.languageMapping = languageMapping;
    });

    this.controller.addKeyListener("referenceFontName", (event) => {
      if (event.newValue) {
        this.editorController.visualizationLayersSettings.model[
          "fontra.reference.font"
        ] = true;
      }
      this.editorController.canvasController.requestUpdate();
    });

    this.controller.addKeyListener("charOverride", (event) => {
      this.editorController.canvasController.requestUpdate();
      this.requestReferenceFontsPreview();
    });

    this.controller.addKeyListener("languageCode", (event) => {
      this.editorController.canvasController.setLangAttribute(this.model.languageCode);
      this.requestReferenceFontsPreview();
    });

    this.editorController.canvasController.setLangAttribute(this.model.languageCode);

    referenceFontModel = this.model;

    this.editorController.sceneSettingsController.addKeyListener(
      "selectedGlyphName",
      (event) => {
        this.requestReferenceFontsPreview();
      }
    );

    editorController.sceneSettingsController.addKeyListener("location", () => {
      const fontVariationSettings = [];
      for (const axis of this.editorController.fontController.globalAxes) {
        fontVariationSettings.push(
          `'${axis.tag}' ${this.editorController.sceneSettings.location[axis.name]}`
        );
      }
      const cssString = fontVariationSettings.join(",");
      this.contentElement.style.fontVariationSettings = cssString;
      this.editorController.canvasController.canvas.style.fontVariationSettings =
        cssString;
      this.editorController.canvasController.requestUpdate();
    });
  }

  async requestReferenceFontsPreview() {
    if (this.referenceFontsPreviewPromise) {
      return this.referenceFontsPreviewPromise;
    }
    this.referenceFontsPreviewPromise = this.displayCurrentGlyphInReferenceFonts();
    await this.referenceFontsPreviewPromise;
    delete this.referenceFontsPreviewPromise;
  }

  async displayCurrentGlyphInReferenceFonts() {
    const container = this.contentElement.querySelector(".reference-font-preview");
    container.innerHTML = "";

    const selectedGlyphInfo = getSelectedGlyphInfo(
      this.editorController.sceneSettings.selectedGlyph,
      this.editorController.sceneSettings.glyphLines
    );

    let textToDisplay;

    if (this.model.charOverride) {
      textToDisplay = this.model.charOverride.charAt(0);
    } else {
      if (selectedGlyphInfo) {
        if (selectedGlyphInfo.glyphName.includes(".")) {
          const baseGlyphName = selectedGlyphInfo.glyphName.split(".")[0];
          const codePoint = (this.editorController.fontController.glyphMap[
            baseGlyphName
          ] || [])[0];
          if (codePoint) {
            textToDisplay = String.fromCodePoint(codePoint);
          }
        } else {
          textToDisplay = selectedGlyphInfo.character;
        }
      }
    }

    if (!textToDisplay) {
      return;
    }

    const currentCharacter = div(
      {
        class: "current-character",
        style: `font-size: ${this.model.fontSize}px`,
        lang: this.model.languageCode,
      },
      []
    );
    const rangeSlider = createDomElement("range-slider", {
      type: "range",
      value: this.model.fontSize,
      minValue: 10,
      defaultValue: DEFAULT_FONT_SIZE,
      maxValue: 300,
      step: 0.1,
      onChangeCallback: (event) => {
        currentCharacter.style.fontSize = `${event.value}px`;
        this.model.fontSize = event.value;
      },
    });

    for (const font of this.model.fontList) {
      await this.ensureFontLoaded(font);
      currentCharacter.appendChild(
        span({ style: `font-family: ${font.fontIdentifier};` }, [` ${textToDisplay}`])
      );
    }
    container.appendChild(rangeSlider);
    container.appendChild(currentCharacter);
  }

  _fontListChangedHandler(event) {
    if (event.senderInfo?.senderID === this) {
      return;
    }
    this.model.selectedFontIndex = -1;

    const itemsByFontID = Object.fromEntries(
      this.filesUIList.items.map((item) => [item.fontIdentifier, item])
    );

    const newItems = event.newValue.map((item) => {
      const existingItem = itemsByFontID[item.fontIdentifier];
      if (existingItem) {
        item = existingItem;
        delete itemsByFontID[item.fontIdentifier];
      }
      return item;
    });

    for (const leftoverItem of Object.values(itemsByFontID)) {
      garbageCollectFontItem(leftoverItem);
    }

    this.filesUIList.setItems(newItems, true);
    if (this.filesUIList.getSelectedItemIndex() === undefined) {
      this.model.referenceFontName = "";
    }
  }

  get model() {
    return this.controller.model;
  }

  async _filesDropHandler(files) {
    const fontItemsInvalid = [];
    const fontItems = [...files]
      .filter((file) => {
        const fileExtension = fileNameExtension(file.name).toLowerCase();
        const fileTypeSupported = fontFileExtensions.has(fileExtension);
        if (!fileTypeSupported) {
          fontItemsInvalid.push(file);
        }
        return fileTypeSupported;
      })
      .map((file) => {
        return {
          uplodadedFileName: file.name,
          droppedFile: file,
          objectURL: URL.createObjectURL(file),
          fontIdentifier: `ReferenceFont-${crypto.randomUUID()}`,
        };
      });

    if (fontItemsInvalid.length) {
      const dialogTitle = `The following item${
        fontItemsInvalid.length > 1 ? "s" : ""
      } can't be used as a reference font:`;
      const dialogMessage = fontItemsInvalid
        .map((file) => {
          return `- ${file.name}`;
        })
        .join("\n");
      dialog(dialogTitle, dialogMessage, [{ title: "Okay" }], 5000);
    }

    const newSelectedItemIndex = this.filesUIList.items.length;
    const newItems = [...this.filesUIList.items, ...fontItems];
    this.filesUIList.setItems(newItems);
    this.filesUIList.setSelectedItemIndex(newSelectedItemIndex, true);

    const writtenFontItems = [...this.model.fontList];
    try {
      for (const fontItem of fontItems) {
        await writeFontFileToOPFS(fontItem.fontIdentifier, fontItem.droppedFile);
        delete fontItem.droppedFile;
        writtenFontItems.push(fontItem);
      }
    } catch (error) {
      message("Could not store some reference fonts", error.toString());
    }

    // Only notify the list controller *after* the files have been written,
    // or else other tabs will try to read the font data too soon and will
    // fail
    this.controller.setItem("fontList", cleanFontItems(writtenFontItems), {
      senderID: this,
    });
  }

  async ensureFontLoaded(fontItem) {
    if (!fontItem.fontFace) {
      if (!fontItem.objectURL) {
        fontItem.objectURL = URL.createObjectURL(
          await readFontFileFromOPFS(fontItem.fontIdentifier)
        );
      }
      fontItem.fontFace = new FontFace(
        fontItem.fontIdentifier,
        `url(${fontItem.objectURL})`,
        {}
      );
      document.fonts.add(fontItem.fontFace);
      await fontItem.fontFace.load();
    }
  }

  async _listSelectionChangedHandler() {
    const fontItem = this.filesUIList.getSelectedItem();
    if (!fontItem) {
      this.model.referenceFontName = "";
      this.model.selectedFontIndex = -1;
      return;
    }

    const selectedFontIndex = this.filesUIList.getSelectedItemIndex();
    this.model.selectedFontIndex =
      selectedFontIndex !== undefined ? selectedFontIndex : -1;

    await this.ensureFontLoaded(fontItem);
    this.model.referenceFontName = fontItem.fontIdentifier;

    if (fontItem.fontIdentifier in this.supportedLanguagesMemoized) {
      this.setSupportedLanguages(
        this.supportedLanguagesMemoized[fontItem.fontIdentifier],
        this.model.languageCode
      );
    } else {
      setTimeout(async () => {
        // file is not resolved when it's read consecutively after creating object url
        // I do not know the reason. I will investigate later, leaving it with a timeout
        const supportedLanguages = await readSupportedLanguages(
          fontItem,
          this.languageMapping
        );
        this.setSupportedLanguages(supportedLanguages, this.model.languageCode);
        this.supportedLanguagesMemoized[fontItem.fontIdentifier] = supportedLanguages;
      }, 100);
    }
  }

  async _deleteSelectedItemHandler() {
    await this._deleteItemOrAll(this.filesUIList.getSelectedItemIndex());
  }

  async _deleteAllHandler() {
    await this._deleteItemOrAll(undefined);
  }

  async _deleteItemOrAll(index) {
    const fontItems = [...this.filesUIList.items];

    let itemsToDelete, newItems;
    if (index !== undefined) {
      itemsToDelete = [fontItems[index]];
      fontItems.splice(index, 1);
      newItems = fontItems;
    } else {
      itemsToDelete = fontItems;
      newItems = [];
    }

    this.model.selectedFontIndex = -1;
    this.model.referenceFontName = "";

    this.filesUIList.setItems(newItems);

    // Only share those fonts that we successfully stored before
    const storedFontIDs = new Set(
      this.model.fontList.map((item) => item.fontIdentifier)
    );
    this.controller.setItem(
      "fontList",
      cleanFontItems(newItems.filter((item) => storedFontIDs.has(item.fontIdentifier))),
      {
        senderID: this,
      }
    );

    for (const fontItem of itemsToDelete) {
      garbageCollectFontItem(fontItem);
      await deleteFontFileFromOPFS(fontItem.fontIdentifier);
    }
  }

  setSupportedLanguages(languages, currentLanguage = "") {
    this.languageCodeInput.innerHTML = "";
    this.languageCodeInput.appendChild(option({ value: "" }, ["None"]));
    for (const [name, code] of languages) {
      this.languageCodeInput.appendChild(
        option(
          {
            value: code,
            selected: currentLanguage === code,
          },
          [`${name} (${code})`]
        )
      );
    }
  }

  getContentElement() {
    this.languageMapping = {};
    this.supportedLanguagesMemoized = {};

    this.controller = new ObservableController({
      languageCode: "",
      fontSize: DEFAULT_FONT_SIZE,
      selectedFontIndex: -1,
      fontList: [],
      charOverride: "",
      referenceFontName: "",
    });
    this.controller.synchronizeWithLocalStorage("fontra.reference-font.");
    this.controller.addKeyListener("fontList", (event) => {
      this._fontListChangedHandler(event);
      this.requestReferenceFontsPreview();
    });
    garbageCollectUnusedFiles(this.model.fontList);

    const columnDescriptions = [
      {
        key: "uplodadedFileName",
        title: "file name",
      },
    ];
    this.filesUIList = new UIList();

    this.filesUIList.columnDescriptions = columnDescriptions;
    this.filesUIList.itemEqualFunc = (a, b) => a.fontIdentifier == b.fontIdentifier;

    this.filesUIList.minHeight = "6em";

    this.filesUIList.onFilesDrop = (files) => this._filesDropHandler(files);

    this.filesUIList.addEventListener("listSelectionChanged", () => {
      this._listSelectionChangedHandler();
    });

    this.filesUIList.addEventListener("deleteKey", () =>
      this._deleteSelectedItemHandler()
    );
    this.filesUIList.addEventListener("deleteKeyAlt", () => this._deleteAllHandler());

    this.filesUIList.setItems([...this.model.fontList]);
    if (this.model.selectedFontIndex != -1) {
      this.filesUIList.setSelectedItemIndex(this.model.selectedFontIndex, true);
    }

    this.languageCodeInput = select(
      {
        id: "language-code",
        style: "width: 100%;",
        onchange: (event) => {
          this.model.languageCode = event.target.value;
        },
      },
      []
    );

    return div(
      {
        class: "sidebar-reference-font",
      },
      [
        div(
          {
            id: "reference-font",
          },
          [
            div({ class: "title" }, ["Reference font"]),
            div({}, [
              "Drop one or more .ttf, .otf, .woff or .woff2 files in the field below:",
            ]),
            this.filesUIList,
            div(
              {
                style: `
                display: grid;
                grid-template-columns: max-content auto;
                align-items: center;
                gap: 0.666em;
                `,
              },
              [
                label({ for: "char-override" }, "Custom character:"),
                input({
                  type: "text",
                  id: "char-override",
                  value: this.model.charOverride,
                  oninput: (event) => (this.model.charOverride = event.target.value),
                }),
                label({ for: "language-code" }, "Language:"),
                this.languageCodeInput,
              ]
            ),
            div({ class: "reference-font-preview" }, []),
          ]
        ),
      ]
    );
  }
}

export function start(editorController, pluginPath) {
  ReferenceFontPanel.prototype.iconPath = `${pluginPath}/reference.svg`;
  customElements.define("reference-font-panel", ReferenceFontPanel);
  editorController.addSidebarPanel(new ReferenceFontPanel(editorController), "right");
}
