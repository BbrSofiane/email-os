package dev.exedev.emailos.androidfixture

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.transparent)
        window.statusBarColor = Color.rgb(41, 40, 38)
        window.navigationBarColor = Color.rgb(41, 40, 38)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.setSystemBarsAppearance(0, android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        }
        val content = findViewById<View>(android.R.id.content)
        val initialLeft = content.paddingLeft
        val initialTop = content.paddingTop
        val initialRight = content.paddingRight
        val initialBottom = content.paddingBottom
        content.setOnApplyWindowInsetsListener { view, insets ->
            val cutout = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) insets.displayCutout else null
            view.setPadding(
                initialLeft + maxOf(insets.systemWindowInsetLeft, cutout?.safeInsetLeft ?: 0),
                initialTop + maxOf(insets.systemWindowInsetTop, cutout?.safeInsetTop ?: 0),
                initialRight + maxOf(insets.systemWindowInsetRight, cutout?.safeInsetRight ?: 0),
                initialBottom + maxOf(insets.systemWindowInsetBottom, cutout?.safeInsetBottom ?: 0),
            )
            insets
        }
        content.requestApplyInsets()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = findWebView(window.decorView)
                if (webView == null) { moveTaskToBack(true); return }
                webView.evaluateJavascript("(typeof window.__emailOsAndroidBack === 'function' && window.__emailOsAndroidBack())") { handled ->
                    if (handled != "true") runOnUiThread { moveTaskToBack(true) }
                }
            }
        })
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is android.view.ViewGroup) {
            for (index in 0 until view.childCount) findWebView(view.getChildAt(index))?.let { return it }
        }
        return null
    }
}
