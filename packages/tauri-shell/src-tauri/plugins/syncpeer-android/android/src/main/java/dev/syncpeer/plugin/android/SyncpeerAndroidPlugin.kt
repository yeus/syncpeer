package dev.syncpeer.plugin.android

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.webkit.MimeTypeMap
import android.app.Activity
import android.content.Context
import androidx.activity.result.ActivityResult
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
