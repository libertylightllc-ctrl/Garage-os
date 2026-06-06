// PhotoCapture media-input helpers. Pure so type/size validation is testable.
//
// The capture/accept defaults map to the file input attributes that make a
// mobile browser open the camera/mic directly:
//   - photo: accept="image/*" capture="environment"  (rear camera on phone)
//   - voice: accept="audio/*" capture="microphone"

export type CaptureKind = "photo" | "voice";

/** 4 MB — well under Vercel Hobby's 4.5 MB serverless body limit. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function defaultAccept(kind: CaptureKind): string {
  return kind === "voice" ? "audio/*" : "image/*";
}

// "environment" works for both photo (rear camera) and voice (microphone): when
// paired with accept="audio/*", mobile browsers open the audio recorder. React's
// HTMLInputElement typing only allows "environment" | "user" | boolean, so we use
// "environment" for both — the behavior diverges via accept, not capture.
// (Kind is part of the signature for caller clarity but presently ignored.)
export function defaultCapture(kind: CaptureKind): "environment" {
  void kind;
  return "environment";
}

/** Size guard — prevents accidental 12-MP camera dumps from hitting Vercel's body cap. */
export function fileTooBig(size: number, max: number = MAX_FILE_BYTES): boolean {
  return size > max;
}

/** Type guard — falls back to filename extensions for cameras with empty MIME. */
export function fileTypeMatches(
  file: { type: string; name: string },
  kind: CaptureKind,
): boolean {
  if (kind === "voice") {
    return (
      file.type.startsWith("audio/") ||
      /\.(mp3|wav|m4a|webm|ogg|aac|flac)$/i.test(file.name)
    );
  }
  return (
    file.type.startsWith("image/") ||
    /\.(jpg|jpeg|png|webp|heic|heif|gif|bmp)$/i.test(file.name)
  );
}
