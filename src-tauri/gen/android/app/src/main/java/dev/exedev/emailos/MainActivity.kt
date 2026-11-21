package dev.exedev.emailos

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The content view is padded by the system insets below, so the window
        // background is what shows behind the status and navigation bars
        // (target API 35 draws edge to edge). Keep it on the app surface
        // (--surface, #292826) with light bar icons.
        val content = findViewById<View>(android.R.id.content)
        window.decorView.setBackgroundColor(SURFACE)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }

        val initialLeft = content.paddingLeft
        val initialTop = content.paddingTop
        val initialRight = content.paddingRight
        val initialBottom = content.paddingBottom
        content.setOnApplyWindowInsetsListener { view, insets ->
            val cutout = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                insets.displayCutout
            } else {
                null
            }
            view.setPadding(
                initialLeft + maxOf(insets.systemWindowInsetLeft, cutout?.safeInsetLeft ?: 0),
                initialTop + maxOf(insets.systemWindowInsetTop, cutout?.safeInsetTop ?: 0),
                initialRight + maxOf(insets.systemWindowInsetRight, cutout?.safeInsetRight ?: 0),
                initialBottom + maxOf(insets.systemWindowInsetBottom, cutout?.safeInsetBottom ?: 0),
            )
            // Keep IME insets available to the WebView for keyboard resize and
            // scroll behavior. The content root itself is padded for safe bars.
            insets
        }
        content.requestApplyInsets()

        // Back follows the page's Escape ladder (src/lib/android-back.ts). When
        // the page has nothing left to close, the task goes to the background;
        // the activity is not finished, so local drafts and state stay loaded.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view == null) {
                    moveTaskToBack(true)
                    return
                }
                view.evaluateJavascript(BACK_SCRIPT) { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        this.webView = webView
    }

    private companion object {
        val SURFACE = Color.rgb(0x29, 0x28, 0x26)
        const val BACK_SCRIPT =
            "(typeof window.__emailOsAndroidBack === 'function' && window.__emailOsAndroidBack() === true)"
    }
}
