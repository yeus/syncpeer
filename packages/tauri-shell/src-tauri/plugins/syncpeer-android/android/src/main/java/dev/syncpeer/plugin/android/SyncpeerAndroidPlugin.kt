package dev.syncpeer.plugin.android

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.webkit.MimeTypeMap
import android.app.Activity
import android.content.Context
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenWithChooserArgs {
  var path: String = ""
  var mimeType: String? = null
  var chooserTitle: String? = null
}

@InvokeArg
class SafWriteFileArgs {
  var treeUri: String = ""
  var relativePath: String = ""
  var bytes: List<Int> = emptyList()
  var mimeType: String? = null
}

@InvokeArg
class SafPathArgs {
  var treeUri: String = ""
  var relativePath: String = ""
  var openParent: Boolean = false
}

@InvokeArg
class AndroidContactUpsertArgs {
  var contactId: String? = null
  var displayName: String = ""
  var note: String? = null
  var phones: List<String> = emptyList()
  var emails: List<String> = emptyList()
}

@InvokeArg
class AndroidContactDeleteArgs {
  var contactId: String = ""
}

@InvokeArg
class AndroidCalendarListArgs {
  var startMs: Long? = null
  var endMs: Long? = null
}

@InvokeArg
class AndroidCalendarUpsertArgs {
  var eventId: String? = null
  var calendarId: String? = null
  var title: String = ""
  var description: String? = null
  var location: String? = null
  var startMs: Long = 0
  var endMs: Long = 0
  var allDay: Boolean = false
}

@InvokeArg
class AndroidCalendarDeleteArgs {
  var eventId: String = ""
}

@TauriPlugin
class SyncpeerAndroidPlugin(private val activity: Activity) : Plugin(activity) {
  private var multicastLock: WifiManager.MulticastLock? = null

  @Command
  fun enableMulticastLock(invoke: Invoke) {
    try {
      val wifiManager =
        activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      if (wifiManager == null) {
        invoke.reject("WifiManager is unavailable.")
        return
      }
      val lock =
        multicastLock
          ?: wifiManager.createMulticastLock("${activity.packageName}:syncpeer-lan").apply {
            setReferenceCounted(false)
          }
      if (!lock.isHeld) {
        lock.acquire()
      }
      multicastLock = lock
      invoke.resolveObject(mapOf("enabled" to true))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not enable multicast lock.")
    }
  }

  @Command
  fun openWithChooser(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenWithChooserArgs::class.java)
      val source = File(args.path)
      if (!source.exists()) {
        invoke.reject("File does not exist: ${args.path}")
        return
      }

      val authority = "${activity.packageName}.fileprovider"
      val uri = FileProvider.getUriForFile(activity, authority, source)
      val mimeType = args.mimeType ?: guessMimeType(source.name)
      val viewIntent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, mimeType)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

      val resolved =
        activity.packageManager.queryIntentActivities(viewIntent, PackageManager.MATCH_DEFAULT_ONLY)
      for (info in resolved) {
        activity.grantUriPermission(
          info.activityInfo.packageName,
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
      }

      val chooser = Intent.createChooser(viewIntent, args.chooserTitle ?: "Open with")
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(chooser)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open file.")
    }
  }

  @Command
  fun writeFileToSafTree(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SafWriteFileArgs::class.java)
      if (args.treeUri.isBlank()) {
        invoke.reject("treeUri is required.")
        return
      }
      if (args.relativePath.isBlank()) {
        invoke.reject("relativePath is required.")
        return
      }
      val tree = DocumentFile.fromTreeUri(activity, Uri.parse(args.treeUri))
      if (tree == null) {
        invoke.reject("Invalid tree URI.")
        return
      }
      val pathParts = args.relativePath.split('/').filter { it.isNotBlank() }
      if (pathParts.isEmpty()) {
        invoke.reject("relativePath is empty.")
        return
      }

      var currentDir: DocumentFile = tree
      for (segment in pathParts.dropLast(1)) {
        val existing = currentDir.findFile(segment)
        currentDir =
          if (existing != null && existing.isDirectory) {
            existing
          } else {
            currentDir.createDirectory(segment)
              ?: throw IllegalStateException("Could not create SAF directory: $segment")
          }
      }

      val fileName = pathParts.last()
      val mimeType = args.mimeType ?: guessMimeType(fileName)
      val existingFile = currentDir.findFile(fileName)
      val target =
        if (existingFile != null && existingFile.isFile) {
          existingFile
        } else {
          currentDir.createFile(mimeType, fileName)
            ?: throw IllegalStateException("Could not create SAF file: $fileName")
        }

      val content = args.bytes.map { it.toByte() }.toByteArray()
      activity.contentResolver.openOutputStream(target.uri, "w").use { stream ->
        if (stream == null) {
          throw IllegalStateException("Could not open SAF output stream.")
        }
        stream.write(content)
        stream.flush()
      }
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not write SAF file.")
    }
  }

  @Command
  fun listPersistedSafTreeUris(invoke: Invoke) {
    try {
      val uris =
        activity.contentResolver.persistedUriPermissions
          .filter { it.isReadPermission || it.isWritePermission }
          .map { it.uri.toString() }
      invoke.resolveObject(uris)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not list persisted SAF URIs.")
    }
  }

  @Command
  fun safPathExists(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SafPathArgs::class.java)
      val target = findSafDocument(args.treeUri, args.relativePath)
      invoke.resolveObject(target != null)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not check SAF path.")
    }
  }

  @Command
  fun deleteSafPath(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SafPathArgs::class.java)
      val target = findSafDocument(args.treeUri, args.relativePath)
      if (target == null) {
        invoke.resolveObject(false)
        return
      }
      invoke.resolveObject(target.delete())
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not delete SAF path.")
    }
  }

  @Command
  fun openSafPathWithChooser(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SafPathArgs::class.java)
      var target = findSafDocument(args.treeUri, args.relativePath)
      if (target == null) {
        invoke.reject("SAF path not found: ${args.relativePath}")
        return
      }
      if (args.openParent) {
        val parentPath = args.relativePath.substringBeforeLast('/', "")
        target =
          if (parentPath.isBlank()) {
            DocumentFile.fromTreeUri(activity, Uri.parse(args.treeUri))
          } else {
            findSafDocument(args.treeUri, parentPath)
          }
      }
      if (target == null) {
        invoke.reject("Could not resolve SAF target.")
        return
      }

      val uri = target.uri
      val mimeType =
        if (target.isDirectory) "vnd.android.document/directory" else guessMimeType(target.name ?: "")
      val viewIntent =
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, mimeType)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

      val resolved =
        activity.packageManager.queryIntentActivities(viewIntent, PackageManager.MATCH_DEFAULT_ONLY)
      for (info in resolved) {
        activity.grantUriPermission(
          info.activityInfo.packageName,
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
      }

      val chooser = Intent.createChooser(viewIntent, "Open with")
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(chooser)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not open SAF path.")
    }
  }

  @Command
  fun pickSafDirectory(invoke: Invoke) {
    val intent =
      Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        .addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)

    startActivityForResult(invoke, intent, "onPickSafDirectoryResult")
  }

  @Command
  fun listContacts(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.READ_CONTACTS)
      val projection =
        arrayOf(
          ContactsContract.Contacts._ID,
          ContactsContract.Contacts.DISPLAY_NAME,
          ContactsContract.Contacts.LOOKUP_KEY,
        )
      val out = mutableListOf<Map<String, Any?>>()
      activity.contentResolver.query(
        ContactsContract.Contacts.CONTENT_URI,
        projection,
        null,
        null,
        "${ContactsContract.Contacts.DISPLAY_NAME} COLLATE NOCASE ASC",
      )?.use { cursor ->
        val idIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
        val nameIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME)
        val lookupIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.LOOKUP_KEY)
        while (cursor.moveToNext()) {
          val contactId = cursor.getLong(idIndex)
          val phones = listPhones(contactId)
          val emails = listEmails(contactId)
          out.add(
            mapOf(
              "contactId" to contactId.toString(),
              "displayName" to (cursor.getString(nameIndex) ?: ""),
              "lookupKey" to (cursor.getString(lookupIndex) ?: ""),
              "phones" to phones,
              "emails" to emails,
            ),
          )
        }
      }
      invoke.resolveObject(out)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not list contacts.")
    }
  }

  @Command
  fun upsertContact(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.WRITE_CONTACTS)
      ensurePermission(Manifest.permission.READ_CONTACTS)
      val args = invoke.parseArgs(AndroidContactUpsertArgs::class.java)
      if (args.displayName.isBlank()) {
        invoke.reject("displayName is required.")
        return
      }
      val resolver = activity.contentResolver
      val existingId = args.contactId?.trim().orEmpty()
      val rawContactId =
        if (existingId.isNotBlank()) {
          findRawContactIdByContactId(existingId)
            ?: throw IllegalStateException("Contact not found for id $existingId")
        } else {
          val values = ContentValues().apply {
            put(ContactsContract.RawContacts.ACCOUNT_TYPE, null as String?)
            put(ContactsContract.RawContacts.ACCOUNT_NAME, null as String?)
          }
          val uri = resolver.insert(ContactsContract.RawContacts.CONTENT_URI, values)
            ?: throw IllegalStateException("Could not create raw contact.")
          ContentUris.parseId(uri)
        }

      resolver.delete(
        ContactsContract.Data.CONTENT_URI,
        "${ContactsContract.Data.RAW_CONTACT_ID} = ?",
        arrayOf(rawContactId.toString()),
      )

      val nameValues = ContentValues().apply {
        put(ContactsContract.Data.RAW_CONTACT_ID, rawContactId)
        put(
          ContactsContract.Data.MIMETYPE,
          ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
        )
        put(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, args.displayName)
      }
      resolver.insert(ContactsContract.Data.CONTENT_URI, nameValues)

      if (!args.note.isNullOrBlank()) {
        val noteValues = ContentValues().apply {
          put(ContactsContract.Data.RAW_CONTACT_ID, rawContactId)
          put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
          put(ContactsContract.CommonDataKinds.Note.NOTE, args.note)
        }
        resolver.insert(ContactsContract.Data.CONTENT_URI, noteValues)
      }

      args.phones.map { it.trim() }.filter { it.isNotBlank() }.forEach { phone ->
        val values = ContentValues().apply {
          put(ContactsContract.Data.RAW_CONTACT_ID, rawContactId)
          put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
          put(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
          put(
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE,
          )
        }
        resolver.insert(ContactsContract.Data.CONTENT_URI, values)
      }

      args.emails.map { it.trim() }.filter { it.isNotBlank() }.forEach { email ->
        val values = ContentValues().apply {
          put(ContactsContract.Data.RAW_CONTACT_ID, rawContactId)
          put(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
          put(ContactsContract.CommonDataKinds.Email.ADDRESS, email)
          put(
            ContactsContract.CommonDataKinds.Email.TYPE,
            ContactsContract.CommonDataKinds.Email.TYPE_OTHER,
          )
        }
        resolver.insert(ContactsContract.Data.CONTENT_URI, values)
      }

      val contactId = findContactIdByRawContactId(rawContactId) ?: rawContactId.toString()
      invoke.resolveObject(mapOf("contactId" to contactId))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not upsert contact.")
    }
  }

  @Command
  fun deleteContact(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.WRITE_CONTACTS)
      val args = invoke.parseArgs(AndroidContactDeleteArgs::class.java)
      val id = args.contactId.trim()
      if (id.isBlank()) {
        invoke.reject("contactId is required.")
        return
      }
      val uri = ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id.toLong())
      val deleted = activity.contentResolver.delete(uri, null, null)
      invoke.resolveObject(mapOf("deleted" to (deleted > 0)))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not delete contact.")
    }
  }

  @Command
  fun listCalendarEvents(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.READ_CALENDAR)
      val args = invoke.parseArgs(AndroidCalendarListArgs::class.java)
      val projection =
        arrayOf(
          CalendarContract.Events._ID,
          CalendarContract.Events.CALENDAR_ID,
          CalendarContract.Events.TITLE,
          CalendarContract.Events.DESCRIPTION,
          CalendarContract.Events.EVENT_LOCATION,
          CalendarContract.Events.DTSTART,
          CalendarContract.Events.DTEND,
          CalendarContract.Events.ALL_DAY,
        )
      val clauses = mutableListOf<String>()
      val values = mutableListOf<String>()
      args.startMs?.let {
        clauses.add("${CalendarContract.Events.DTSTART} >= ?")
        values.add(it.toString())
      }
      args.endMs?.let {
        clauses.add("${CalendarContract.Events.DTSTART} <= ?")
        values.add(it.toString())
      }
      val selection = if (clauses.isEmpty()) null else clauses.joinToString(" AND ")
      val selectionArgs = if (values.isEmpty()) null else values.toTypedArray()
      val out = mutableListOf<Map<String, Any?>>()
      activity.contentResolver.query(
        CalendarContract.Events.CONTENT_URI,
        projection,
        selection,
        selectionArgs,
        "${CalendarContract.Events.DTSTART} ASC",
      )?.use { cursor ->
        while (cursor.moveToNext()) {
          out.add(
            mapOf(
              "eventId" to cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events._ID)).toString(),
              "calendarId" to cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.CALENDAR_ID)).toString(),
              "title" to (cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.TITLE)) ?: ""),
              "description" to cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.DESCRIPTION)),
              "location" to cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.EVENT_LOCATION)),
              "startMs" to cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTSTART)),
              "endMs" to cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTEND)),
              "allDay" to (cursor.getInt(cursor.getColumnIndexOrThrow(CalendarContract.Events.ALL_DAY)) == 1),
            ),
          )
        }
      }
      invoke.resolveObject(out)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not list calendar events.")
    }
  }

  @Command
  fun upsertCalendarEvent(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.WRITE_CALENDAR)
      ensurePermission(Manifest.permission.READ_CALENDAR)
      val args = invoke.parseArgs(AndroidCalendarUpsertArgs::class.java)
      if (args.title.isBlank()) {
        invoke.reject("title is required.")
        return
      }
      if (args.startMs <= 0 || args.endMs <= 0 || args.endMs < args.startMs) {
        invoke.reject("startMs/endMs are invalid.")
        return
      }
      val calendarId = resolveCalendarId(args.calendarId)
      val values = ContentValues().apply {
        put(CalendarContract.Events.CALENDAR_ID, calendarId)
        put(CalendarContract.Events.TITLE, args.title)
        put(CalendarContract.Events.DESCRIPTION, args.description)
        put(CalendarContract.Events.EVENT_LOCATION, args.location)
        put(CalendarContract.Events.DTSTART, args.startMs)
        put(CalendarContract.Events.DTEND, args.endMs)
        put(CalendarContract.Events.ALL_DAY, if (args.allDay) 1 else 0)
        put(CalendarContract.Events.EVENT_TIMEZONE, java.util.TimeZone.getDefault().id)
      }
      val eventId = args.eventId?.trim().orEmpty()
      val resolvedId =
        if (eventId.isBlank()) {
          val inserted = activity.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?: throw IllegalStateException("Could not insert event.")
          ContentUris.parseId(inserted).toString()
        } else {
          val target = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId.toLong())
          val updated = activity.contentResolver.update(target, values, null, null)
          if (updated <= 0) throw IllegalStateException("Could not update event $eventId")
          eventId
        }
      invoke.resolveObject(mapOf("eventId" to resolvedId))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not upsert calendar event.")
    }
  }

  @Command
  fun deleteCalendarEvent(invoke: Invoke) {
    try {
      ensurePermission(Manifest.permission.WRITE_CALENDAR)
      val args = invoke.parseArgs(AndroidCalendarDeleteArgs::class.java)
      val id = args.eventId.trim()
      if (id.isBlank()) {
        invoke.reject("eventId is required.")
        return
      }
      val target = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id.toLong())
      val deleted = activity.contentResolver.delete(target, null, null)
      invoke.resolveObject(mapOf("deleted" to (deleted > 0)))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Could not delete calendar event.")
    }
  }

  @ActivityCallback
  fun onPickSafDirectoryResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.reject("SAF directory selection was cancelled.")
      return
    }
    val uri = result.data?.data
    if (uri == null) {
      invoke.reject("No SAF directory selected.")
      return
    }

    val grantedFlags =
      (result.data?.flags ?: 0) and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    activity.contentResolver.takePersistableUriPermission(uri, grantedFlags)
    invoke.resolveObject(mapOf("treeUri" to uri.toString()))
  }

  private fun guessMimeType(fileName: String): String {
    val extension = fileName.substringAfterLast('.', "").lowercase()
    if (extension.isBlank()) {
      return "application/octet-stream"
    }
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      ?: "application/octet-stream"
  }

  private fun ensurePermission(permission: String) {
    if (ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED) {
      return
    }
    ActivityCompat.requestPermissions(activity, arrayOf(permission), 1803)
    throw IllegalStateException("Missing Android permission: $permission")
  }

  private fun listPhones(contactId: Long): List<String> {
    val out = mutableListOf<String>()
    activity.contentResolver.query(
      ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
      "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
      arrayOf(contactId.toString()),
      null,
    )?.use { cursor ->
      val index = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
      while (cursor.moveToNext()) {
        val value = cursor.getString(index)?.trim().orEmpty()
        if (value.isNotBlank()) out.add(value)
      }
    }
    return out.distinct()
  }

  private fun listEmails(contactId: Long): List<String> {
    val out = mutableListOf<String>()
    activity.contentResolver.query(
      ContactsContract.CommonDataKinds.Email.CONTENT_URI,
      arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
      "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
      arrayOf(contactId.toString()),
      null,
    )?.use { cursor ->
      val index = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Email.ADDRESS)
      while (cursor.moveToNext()) {
        val value = cursor.getString(index)?.trim().orEmpty()
        if (value.isNotBlank()) out.add(value)
      }
    }
    return out.distinct()
  }

  private fun findRawContactIdByContactId(contactId: String): Long? {
    activity.contentResolver.query(
      ContactsContract.RawContacts.CONTENT_URI,
      arrayOf(ContactsContract.RawContacts._ID),
      "${ContactsContract.RawContacts.CONTACT_ID} = ?",
      arrayOf(contactId),
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        return cursor.getLong(cursor.getColumnIndexOrThrow(ContactsContract.RawContacts._ID))
      }
    }
    return null
  }

  private fun findContactIdByRawContactId(rawContactId: Long): String? {
    activity.contentResolver.query(
      ContactsContract.RawContacts.CONTENT_URI,
      arrayOf(ContactsContract.RawContacts.CONTACT_ID),
      "${ContactsContract.RawContacts._ID} = ?",
      arrayOf(rawContactId.toString()),
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        return cursor.getLong(cursor.getColumnIndexOrThrow(ContactsContract.RawContacts.CONTACT_ID)).toString()
      }
    }
    return null
  }

  private fun resolveCalendarId(requestedId: String?): Long {
    val requested = requestedId?.trim().orEmpty()
    if (requested.isNotBlank()) return requested.toLong()
    activity.contentResolver.query(
      CalendarContract.Calendars.CONTENT_URI,
      arrayOf(CalendarContract.Calendars._ID),
      "${CalendarContract.Calendars.VISIBLE} = 1",
      null,
      "${CalendarContract.Calendars.IS_PRIMARY} DESC, ${CalendarContract.Calendars._ID} ASC",
    )?.use { cursor ->
      if (cursor.moveToFirst()) {
        return cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Calendars._ID))
      }
    }
    throw IllegalStateException("No visible calendar available on this device.")
  }

  private fun findSafDocument(treeUri: String, relativePath: String): DocumentFile? {
    val tree = DocumentFile.fromTreeUri(activity, Uri.parse(treeUri)) ?: return null
    val pathParts = relativePath.split('/').filter { it.isNotBlank() }
    if (pathParts.isEmpty()) return tree
    var current: DocumentFile = tree
    for (segment in pathParts) {
      val next = current.findFile(segment) ?: return null
      current = next
    }
    return current
  }
}
