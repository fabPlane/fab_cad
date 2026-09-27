/** Browser file I/O: a file picker, downloads, and reading dropped files. */

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    let done = false;
    input.addEventListener("change", () => {
      done = true;
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    // No change event on cancel in every browser; resolve empty when the window regains focus.
    window.addEventListener(
      "focus",
      () =>
        setTimeout(() => {
          if (!done) resolve([]);
        }, 1000),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export function download(data: Uint8Array | string, fileName: string, type = "application/octet-stream"): void {
  const blob = new Blob([typeof data === "string" ? data : (data as BlobPart)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export async function fileBytes(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** File name extension, lower case, without the dot. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export const IMPORT_EXTENSIONS = ["step", "stp", "iges", "igs", "brep", "brp", "stl", "obj"];
export const OPEN_ACCEPT = ".FCStd,.fcstd,.step,.stp,.iges,.igs,.brep,.brp,.stl,.obj";
export const IMPORT_ACCEPT = ".step,.stp,.iges,.igs,.brep,.brp,.stl,.obj";
