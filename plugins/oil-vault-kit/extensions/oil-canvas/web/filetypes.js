// File-type classification shared by the tree, lists and the note pane.

const set = (s) => new Set(s.split(" "));
const KINDS = [
    ["md", set("md")],
    ["image", set("png jpg jpeg gif svg webp bmp avif ico")],
    ["html", set("html htm")],
    ["pdf", set("pdf")],
    ["slides", set("pptx pptm potx ppsx")],
    ["doc", set("docx docm dotx")],
    ["sheet", set("xlsx xlsm xltx")],
    ["legacy", set("ppt pps doc xls rtf odt odp ods vsdx one")],
    ["audio", set("mp3 wav m4a aac ogg oga opus flac weba")],
    ["video", set("mp4 m4v webm ogv mov")],
    ["csv", set("csv tsv")],
    ["text", set("txt log json jsonl yaml yml xml toml ini conf cfg env js mjs cjs ts tsx jsx py ps1 psm1 sh bash zsh bat cmd css scss less sql kql graphql go rs java kt cs c h cpp hpp rb php swift r lua dockerfile makefile gitignore canvas excalidraw base")],
];
const BY_EXT = new Map(KINDS.flatMap(([kind, exts]) => [...exts].map((e) => [e, kind])));

export const KIND_META = {
    md: { icon: "file", label: "Note" },
    image: { icon: "image", label: "Image" },
    html: { icon: "globe", label: "Web page" },
    pdf: { icon: "book", label: "PDF" },
    slides: { icon: "slides", label: "PowerPoint" },
    doc: { icon: "doc", label: "Word document" },
    sheet: { icon: "table", label: "Excel workbook" },
    legacy: { icon: "paperclip", label: "Document" },
    audio: { icon: "music", label: "Audio" },
    video: { icon: "film", label: "Video" },
    csv: { icon: "table", label: "Table" },
    text: { icon: "code", label: "Text" },
    other: { icon: "paperclip", label: "File" },
};

export function fileExt(path) {
    const name = String(path || "").split("/").pop().toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1) : name;
}

/** md | image | html | pdf | slides | doc | sheet | legacy | audio | video | csv | text | other */
export function fileKind(path) {
    return BY_EXT.get(fileExt(path)) || "other";
}

export function fileIcon(path) {
    return KIND_META[fileKind(path)].icon;
}
