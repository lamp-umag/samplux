package cl.umag.lamp.samplux

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Crash-proof native SQLite + disk mirror outbox for Samplux Field & Lab mode.
 * Unlike browser IndexedDB (which can be evicted by the OS and omits audio blobs on JSON export),
 * DurableOutbox persists every queued submission + raw audio clip to SQLite and mirrors a surviving
 * .zip bundle on disk ready for P2P Data Mule transfer (Nearby Share / Wi-Fi Direct / USB).
 */
class DurableOutbox(private val context: Context) :
    SQLiteOpenHelper(context, "samplux_durable_outbox.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS submissions (
                response_id TEXT PRIMARY KEY,
                survey_id TEXT NOT NULL,
                queued_at TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                audio_count INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    private fun backupDir(): File {
        val dir = File(context.filesDir, "outbox_backups")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    fun enqueueFromJson(rawJson: String) {
        val obj = JSONObject(rawJson)
        val responseId = obj.optString("responseId").ifEmpty { return }
        val surveyId = obj.optString("surveyId", "unknown")
        val queuedAt = obj.optString("queuedAt", "")
        val clips = obj.optJSONArray("clips") ?: JSONArray()

        // Write decoded audio blobs to durable app files and strip inline base64 from SQLite row
        val caseDir = File(backupDir(), "${surveyId}__${responseId}")
        if (!caseDir.exists()) caseDir.mkdirs()

        val cleanClips = JSONArray()
        for (i in 0 until clips.length()) {
            val clip = clips.getJSONObject(i)
            val itemId = clip.optString("itemId", "item_$i")
            val mime = clip.optString("mime", "audio/webm")
            val ext = when {
                mime.contains("mp4") || mime.contains("aac") -> "m4a"
                mime.contains("ogg") -> "ogg"
                else -> "webm"
            }
            val b64 = clip.optString("base64", "")
            val audioFileName = "${responseId}__${itemId}.$ext"
            if (b64.isNotEmpty()) {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                File(caseDir, audioFileName).writeBytes(bytes)
            }
            cleanClips.put(
                JSONObject()
                    .put("itemId", itemId)
                    .put("docId", clip.optString("docId"))
                    .put("mime", mime)
                    .put("durationMs", clip.optLong("durationMs"))
                    .put("size", clip.optLong("size"))
                    .put("file", audioFileName)
            )
        }

        val cleanObj = JSONObject(rawJson).put("clips", cleanClips)
        File(caseDir, "submission.json").writeText(cleanObj.toString(2))

        val cv = ContentValues().apply {
            put("response_id", responseId)
            put("survey_id", surveyId)
            put("queued_at", queuedAt)
            put("payload_json", cleanObj.toString())
            put("audio_count", clips.length())
        }
        writableDatabase.insertWithOnConflict("submissions", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun markSynced(responseId: String) {
        writableDatabase.delete("submissions", "response_id = ?", arrayOf(responseId))
    }

    fun pendingCount(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM submissions", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    /**
     * Packages all durable outbox records + raw audio recordings into a single .zip file
     * and launches Android's share sheet (Nearby Share / Wi-Fi Direct Data Mule / Drive / USB).
     */
    fun exportAndShareMuleZip(): File? {
        val exportDir = File(context.cacheDir, "exports").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val zipFile = File(exportDir, "samplux-field-mule-$stamp.zip")

        val records = JSONArray()
        readableDatabase.rawQuery(
            "SELECT response_id, survey_id, payload_json FROM submissions ORDER BY queued_at ASC",
            null
        ).use { cursor ->
            ZipOutputStream(FileOutputStream(zipFile)).use { zos ->
                while (cursor.moveToNext()) {
                    val responseId = cursor.getString(0)
                    val surveyId = cursor.getString(1)
                    val payload = JSONObject(cursor.getString(2))
                    records.put(payload)

                    // Include any raw audio files for this submission
                    val caseDir = File(backupDir(), "${surveyId}__${responseId}")
                    if (caseDir.exists()) {
                        caseDir.listFiles()?.forEach { f ->
                            if (f.isFile && !f.name.endsWith(".json")) {
                                zos.putNextEntry(ZipEntry("audio/${f.name}"))
                                f.inputStream().use { it.copyTo(zos) }
                                zos.closeEntry()
                            }
                        }
                    }
                }
                val manifest = JSONObject()
                    .put("exportedAt", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date()))
                    .put("source", "samplux-android-durable-outbox")
                    .put("totalRecords", records.length())
                    .put("records", records)

                zos.putNextEntry(ZipEntry("submissions.json"))
                zos.write(manifest.toString(2).toByteArray(Charsets.UTF_8))
                zos.closeEntry()
            }
        }

        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", zipFile)
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "Respaldo Samplux Field (${records.length()} casos + audios)")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(shareIntent, "Enviar respaldo Data Mule (.zip)").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        return zipFile
    }
}
