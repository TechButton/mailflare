/** File extensions Brevo's send API lists as allowed. Anything else goes as a download link. */
const BREVO_EXTENSIONS = new Set((
	"xlsx xls ods docx docm doc csv pdf txt gif jpg jpeg png tif tiff rtf bmp cgm css shtml html htm zip xml ppt pptx tar ez ics mobi msg pub eps odt " +
	"mp3 m4a m4v wma ogg flac wav aif aifc aiff mp4 mov avi mkv mpeg mpg wmv pkpass xlsm"
).split(" "));

export function isBrevoAttachmentName(filename: string): boolean {
	const dot = filename.lastIndexOf(".");
	return dot >= 0 && BREVO_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}
