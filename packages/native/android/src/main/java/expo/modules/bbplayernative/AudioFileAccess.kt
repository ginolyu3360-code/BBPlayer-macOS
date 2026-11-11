package expo.modules.bbplayernative

import android.content.Context
import android.content.Intent
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri

/** Read-only access to user-selected originals. Never copies, tags or deletes the audio. */
internal object AudioFileAccess {
    fun read(context: Context, value: String, retain: Boolean): Map<String, Any?> {
        val uri = Uri.parse(value)
        require(uri.scheme == "content" || uri.scheme == "file") { "Choose a local audio document." }
        val resolver = context.contentResolver
        if (uri.scheme == "content" && retain && resolver.persistedUriPermissions.none { it.uri == uri && it.isReadPermission }) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (error: SecurityException) {
                throw IllegalArgumentException("This provider cannot retain read access. Choose the original from device storage again.", error)
            }
        }
        val extractor = MediaExtractor()
        val metadata = MediaMetadataRetriever()
        try {
            extractor.setDataSource(context, uri, null)
            val format = (0 until extractor.trackCount).map { extractor.getTrackFormat(it) }
                .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw IllegalArgumentException("The selected document has no audio track.")
            val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
            require(mime in setOf("audio/mpeg", "audio/mp4a-latm", "audio/flac", "audio/raw")) {
                "Supported input formats are MP3, AAC/M4A, FLAC and WAV."
            }
            require(MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) != null) {
                "This device does not report a decoder for the selected audio."
            }
            metadata.setDataSource(context, uri)
            return mapOf(
                "uri" to value,
                "title" to metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE),
                "artist" to metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST),
                "duration" to ((metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0) / 1000.0),
                "mimeType" to mime
            )
        } finally {
            extractor.release()
            metadata.release()
        }
    }
}
