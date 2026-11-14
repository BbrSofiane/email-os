package dev.exedev.emailos.androidfixture

import android.os.Build
import android.os.Bundle
import android.view.View

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val content = findViewById<View>(android.R.id.content)
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
    }
}
