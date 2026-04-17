package com.mobixbuild.client

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.mobixbuild.client.api.BuildMode
import com.mobixbuild.client.ui.BuildScreen
import com.mobixbuild.client.ui.HomeScreen
import com.mobixbuild.client.ui.ResultScreen
import com.mobixbuild.client.ui.theme.BgDeep
import com.mobixbuild.client.ui.theme.MobixBuildTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MobixBuildTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = BgDeep) {
                    MobixBuildApp()
                }
            }
        }
    }
}

@Composable
fun MobixBuildApp() {
    val nav = rememberNavController()

    // Shared state passed through navigation args where possible;
    // fileUri needs to be held in a shared remembered state since
    // Uri can't be serialized as a nav arg.
    var pendingFileUri by remember { mutableStateOf<Uri?>(null) }

    NavHost(navController = nav, startDestination = "home") {

        composable("home") {
            HomeScreen(
                onBuildStart = { repoUrl, fileUri, mode ->
                    pendingFileUri = fileUri
                    val encodedUrl = Uri.encode(repoUrl ?: "")
                    nav.navigate("build/$encodedUrl/${mode.id}")
                }
            )
        }

        composable(
            route = "build/{repoUrl}/{mode}",
            arguments = listOf(
                navArgument("repoUrl") { type = NavType.StringType; defaultValue = "" },
                navArgument("mode")    { type = NavType.StringType },
            )
        ) { entry ->
            val repoUrl = Uri.decode(entry.arguments?.getString("repoUrl") ?: "").ifEmpty { null }
            val modeId  = entry.arguments?.getString("mode") ?: "quick"
            val mode    = BuildMode.entries.firstOrNull { it.id == modeId } ?: BuildMode.QUICK

            BuildScreen(
                repoUrl   = repoUrl,
                fileUri   = pendingFileUri,
                mode      = mode,
                onSuccess = { buildId, m ->
                    nav.navigate("result/$buildId/${m.id}") {
                        popUpTo("home") // keep home in back stack
                    }
                },
                onFailed  = { nav.popBackStack() },
            )
        }

        composable(
            route = "result/{buildId}/{mode}",
            arguments = listOf(
                navArgument("buildId") { type = NavType.StringType },
                navArgument("mode")    { type = NavType.StringType },
            )
        ) { entry ->
            val buildId = entry.arguments?.getString("buildId") ?: ""
            val modeId  = entry.arguments?.getString("mode") ?: "quick"
            val mode    = BuildMode.entries.firstOrNull { it.id == modeId } ?: BuildMode.QUICK

            ResultScreen(
                buildId       = buildId,
                mode          = mode,
                onBuildAnother = {
                    pendingFileUri = null
                    nav.navigate("home") { popUpTo("home") { inclusive = true } }
                },
            )
        }
    }
}
