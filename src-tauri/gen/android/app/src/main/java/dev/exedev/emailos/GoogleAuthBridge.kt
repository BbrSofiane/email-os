package dev.exedev.emailos

import android.accounts.Account
import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class AuthorizeArgs {
    lateinit var scopes: List<String>
    var account: String? = null
    var interactive: Boolean = false
}
@InvokeArg
class ClearTokenArgs {
    lateinit var token: String
}
@InvokeArg
class KeystoreStoreArgs {
    lateinit var json: String
}

@TauriPlugin
class GoogleAuthBridge(private val activity: Activity) : Plugin(activity) {
    private val alias = "email-os-gmail-binding"
    private val file get() = File(activity.noBackupFilesDir, "gmail-binding.bin")
    private fun ok(invoke: Invoke, value: Any) {
        invoke.resolve(JSObject().put("ok", value) as JSObject)
    }
    private fun error(invoke: Invoke, tag: String) {
        invoke.resolve(JSObject().put("error", tag) as JSObject)
    }

    private fun failure(invoke: Invoke, e: Exception) {
        val code = (e as? ApiException)?.statusCode
        if (code != null) {
            Log.w("EmailOsAuth", "authorize failed: status $code")
        }
        error(invoke, statusTag(code))
    }

    private fun statusTag(code: Int?): String = when (code) {
        // Invalid application configuration.
        10 -> "developerError"
        // Network failure.
        7 -> "network"
        // Account selection or consent required.
        4, 6 -> "needsUserInteraction"
        // User cancelled.
        16, 12501 -> "cancelled"
        // Play services unavailable.
        17, 1, 2, 3 -> "playServicesUnavailable"
        // All other failures.
        else -> "failed"
    }

    private fun resolveAuthorization(invoke: Invoke, result: AuthorizationResult) {
        val token = result.accessToken ?: return error(invoke, "failed")
        val value = JSObject()
        value.put("accessToken", token)
        value.put("grantedScopes", JSONArray(result.grantedScopes))
        value.put("email", result.toGoogleSignInAccount()?.email ?: JSONObject.NULL)
        value.put("expiresAtEpochMs", JSONObject.NULL)
        ok(invoke, value)
    }

    @Command
    fun authorize(invoke: Invoke) {
        try {
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS) {
                return error(invoke, "playServicesUnavailable")
            }
            val args = invoke.parseArgs(AuthorizeArgs::class.java)
            val request = AuthorizationRequest.builder()
                .setRequestedScopes(args.scopes.map { Scope(it) })
                .apply { args.account?.let { setAccount(Account(it, "com.google")) } }
                .build()
            Identity.getAuthorizationClient(activity)
                .authorize(request)
                .addOnSuccessListener { result ->
                    try {
                        if (result.hasResolution()) {
                            if (args.interactive) {
                                val intent = IntentSenderRequest.Builder(result.pendingIntent!!.intentSender)
                                    .build()
                                startIntentSenderForResult(invoke, intent, "consentResult")
                            } else {
                                error(invoke, "needsUserInteraction")
                            }
                        } else {
                            resolveAuthorization(invoke, result)
                        }
                    } catch (e: Exception) {
                        failure(invoke, e)
                    }
                }
                .addOnFailureListener { failure(invoke, it) }
        } catch (e: Exception) {
            failure(invoke, e)
        }
    }

    @ActivityCallback
    fun consentResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            return error(invoke, "cancelled")
        }
        try {
            resolveAuthorization(invoke, Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(result.data))
        } catch (e: Exception) {
            failure(invoke, e)
        }
    }

    @Command
    fun clearToken(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ClearTokenArgs::class.java)
            val request = ClearTokenRequest.builder()
                .setToken(args.token)
                .build()
            Identity.getAuthorizationClient(activity)
                .clearToken(request)
                .addOnSuccessListener { ok(invoke, true) }
                .addOnFailureListener {
                    val tag = if (it is ApiException && it.statusCode == 17 || it is UnsupportedOperationException) {
                        "unsupported"
                    } else {
                        "failed"
                    }
                    error(invoke, tag)
                }
        } catch (_: NoSuchMethodError) {
            error(invoke, "unsupported")
        } catch (_: UnsupportedOperationException) {
            error(invoke, "unsupported")
        } catch (_: Exception) {
            error(invoke, "failed")
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }
    private fun key(store: KeyStore): SecretKey {
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build())
        }.generateKey()
    }

    @Command
    fun keystoreLoad(invoke: Invoke) {
        try {
            if (!file.exists()) {
                return ok(invoke, JSONObject.NULL)
            }
            val bytes = file.readBytes()
            val store = keyStore()
            val existing = store.getKey(alias, null) as? SecretKey ?: return error(invoke, "failed")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, existing, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            ok(invoke, String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        } catch (_: Exception) {
            error(invoke, "failed")
        }
    }

    @Command
    fun keystoreStore(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeystoreStoreArgs::class.java)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(keyStore()))
            val temp = File(activity.noBackupFilesDir, "gmail-binding.bin.tmp")
            temp.writeBytes(cipher.iv + cipher.doFinal(args.json.toByteArray(Charsets.UTF_8)))
            check(temp.renameTo(file))
            ok(invoke, true)
        } catch (_: Exception) {
            error(invoke, "failed")
        }
    }

    @Command
    fun keystoreClear(invoke: Invoke) {
        try {
            if (file.exists()) {
                check(file.delete())
            }
            keyStore().deleteEntry(alias)
            ok(invoke, true)
        } catch (_: Exception) {
            error(invoke, "failed")
        }
    }
}
