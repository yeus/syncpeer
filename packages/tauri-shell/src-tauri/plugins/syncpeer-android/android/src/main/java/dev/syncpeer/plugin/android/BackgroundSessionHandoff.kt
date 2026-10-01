package dev.syncpeer.plugin.android

internal class BackgroundSessionHandoff {
  private var preparedRequest: String? = null
  private var startedRequest: String? = null

  @Synchronized
  fun prepare(request: String) {
    if (preparedRequest == request) return
    preparedRequest = request
    startedRequest = null
  }

  @Synchronized
  fun startPrepared(start: (String) -> Unit): Boolean {
    val request = preparedRequest ?: return false
    if (startedRequest == request) return false
    start(request)
    startedRequest = request
    return true
  }

  @Synchronized
  fun clear() {
    preparedRequest = null
    startedRequest = null
  }
}
