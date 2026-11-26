export type PickedFile = {
  readonly name: string;
  readonly bytes: Uint8Array;
};

export function pickFiles(
  multiple: boolean,
  onPicked: (files: readonly PickedFile[]) => void,
) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = multiple;
  picker.onchange = () => {
    const chosen = [...picker.files ?? []];
    if (chosen.length === 0) return;
    void Promise.all(chosen.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }))).then(onPicked);
  };
  picker.click();
}
