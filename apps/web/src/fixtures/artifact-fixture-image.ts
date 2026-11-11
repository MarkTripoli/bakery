import { useEffect, useState } from "react";

export function useArtifactFixtureImage(state: string): string {
  const [image, setImage] = useState("");
  useEffect(() => {
    if (state !== "image") return;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 240;
    const context = canvas.getContext("2d");
    if (!context) return;
    let disposed = false;
    let imageUrl: string | undefined;
    void document.fonts.ready.then(() => {
      if (disposed) return;
      context.fillStyle = "#EEF0F4";
      context.fillRect(0, 0, 640, 240);
      context.font = "400 20px Geist, sans-serif";
      context.textAlign = "center";
      context.strokeStyle = "#141A24";
      context.fillStyle = "#141A24";
      context.lineWidth = 2;
      for (const [index, label] of ["Publish", "Verify", "Retain"].entries()) {
        const x = 24 + index * 216;
        context.beginPath();
        context.roundRect(x, 72, 160, 96, 6);
        context.stroke();
        context.fillText(label, x + 80, 128);
        if (index < 2) {
          context.beginPath();
          context.moveTo(x + 160, 120);
          context.lineTo(x + 216, 120);
          context.stroke();
        }
      }
      canvas.toBlob((blob) => {
        if (!blob || disposed) return;
        imageUrl = URL.createObjectURL(blob);
        setImage(imageUrl);
      }, "image/png");
    });
    return () => {
      disposed = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [state]);
  return image;
}
