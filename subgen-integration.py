#!/usr/bin/env python3
"""
Subgen Integration Plugin - Python Backend
Calls Subgen webhook from within Stash container (server-side)
"""

import json
import sys
import requests
import os
import subprocess
import tempfile
import shutil
import urllib3

# Disable SSL warnings for internal Docker network calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Subgen webhook URL (Docker container name)
SUBGEN_WEBHOOK_URL = os.getenv("SUBGEN_WEBHOOK_URL", "http://subgen:9000")

# Global variables for Stash connection (set from input)
STASH_GRAPHQL_URL = None
STASH_API_KEY = None
STASH_SESSION_COOKIE = None
DEBUG = False  # Debug logging flag (set from input)


def __log(level_char: str, message):
    """Log message to stderr with Stash protocol (SOH + level + STX + message)"""
    # Stash uses control characters to identify log levels:
    # \x01 (SOH) + level_char + \x02 (STX) + message
    # Levels: t=trace, d=debug, i=info, w=warning, e=error, p=progress
    # Note: Stash automatically prepends "[Plugin / {name}]" so we don't need to add plugin name
    prefix = f"\x01{level_char}\x02"
    print(prefix, message, file=sys.stderr, flush=True)

def log_trace(message):
    __log("t", message)

def log_debug(message):
    if DEBUG:
        # When debug is enabled, use INFO level so messages are visible in Stash logs
        # (Stash filters out 'd' level by default)
        __log("i", message)

def log_info(message):
    __log("i", message)

def log_warning(message):
    __log("w", message)

def log_error(message):
    __log("e", message)


def check_pipe_compatibility(file_path):
    """
    Test if a file works through ffmpeg pipe (non-seekable input).
    Some valid MP4s fail when read via stdin/pipe due to moov atom positioning.
    
    Returns:
        True if file works through pipe, False if it has pipe issues
    """
    try:
        # Simulate pipe input: cat file | ffmpeg -i pipe: -f null -
        # This is how Subgen reads uploaded files
        cat_process = subprocess.Popen(
            ['cat', file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL
        )
        
        ffmpeg_process = subprocess.Popen(
            ['ffmpeg', '-v', 'error', '-i', 'pipe:', '-f', 'null', '-'],
            stdin=cat_process.stdout,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE
        )
        
        cat_process.stdout.close()
        _, stderr = ffmpeg_process.communicate(timeout=30)
        
        # Wait for cat process to avoid zombie
        cat_process.wait()
        
        # Check if ffmpeg succeeded
        if ffmpeg_process.returncode == 0:
            return True
        else:
            # File failed pipe test
            error_msg = stderr.decode('utf-8', errors='ignore').strip()
            if 'partial file' in error_msg.lower() or 'invalid data' in error_msg.lower():
                log_warning("File failed pipe compatibility test (moov atom issue)")
                log_debug(f"FFmpeg error: {error_msg[:200]}")
            else:
                log_warning(f"File failed pipe test: {error_msg[:200]}")
            return False
            
    except subprocess.TimeoutExpired:
        log_warning("Pipe compatibility test timed out")
        return False
    except Exception as e:
        log_warning(f"Could not test pipe compatibility: {e}")
        return True  # Assume compatible if we can't test


def remux_for_pipe_compatibility(file_path, create_backup=False):
    """
    Remux an MP4 file to fix pipe compatibility issues.
    Uses ffmpeg to move the moov atom to the beginning (+faststart).
    
    Args:
        file_path: Path to original file
        create_backup: If True, create .bak backup of original
        
    Returns:
        Path to remuxed temp file, or None if remux failed
    """
    log_info(f"Remuxing file to fix pipe compatibility: {os.path.basename(file_path)}")
    
    temp_path = None
    try:
        # Create backup if requested
        if create_backup:
            backup_path = file_path + '.bak'
            log_info(f"Creating backup: {os.path.basename(backup_path)}")
            shutil.copy2(file_path, backup_path)
        
        # Create temp file for remuxed output
        temp_fd, temp_path = tempfile.mkstemp(suffix='.mp4', prefix='subgen_remux_')
        os.close(temp_fd)  # Close fd, we'll let ffmpeg write to it
        
        log_debug(f"Remuxing to temp file: {temp_path}")
        
        # Remux with faststart flag to move moov atom to beginning
        # -c copy = copy streams without re-encoding (fast)
        # -movflags +faststart = move moov atom to beginning (fixes pipe issues)
        result = subprocess.run(
            [
                'ffmpeg',
                '-v', 'error',
                '-i', file_path,
                '-c', 'copy',
                '-movflags', '+faststart',
                '-y',  # Overwrite output
                temp_path
            ],
            capture_output=True,
            timeout=300  # 5 minute timeout
        )
        
        if result.returncode == 0:
            # Verify temp file exists and has content
            if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
                log_info(f"✓ Remux successful, temp file: {os.path.basename(temp_path)}")
                return temp_path
            else:
                log_error("Remux produced empty file")
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                return None
        else:
            error_msg = result.stderr.decode('utf-8', errors='ignore').strip()
            log_error(f"Remux failed: {error_msg[:200]}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return None
            
    except subprocess.TimeoutExpired:
        log_error("Remux timed out after 5 minutes")
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        return None
    except Exception as e:
        log_error(f"Remux error: {e}")
        # Clean up temp file on ANY exception (OSError, etc.)
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except:
                pass
        return None


def query_scene_file_path(scene_id):
    """Query Stash GraphQL API for scene file path"""
    log_info(f"Querying scene {scene_id}")
    
    query = """
        query FindScene($id: ID!) {
            findScene(id: $id) {
                id
                title
                files {
                    path
                    basename
                }
            }
        }
    """
    
    variables = {"id": str(scene_id)}
    
    # Build headers
    headers = {"Content-Type": "application/json"}
    if STASH_API_KEY:
        headers["ApiKey"] = STASH_API_KEY
    
    # Build cookies dict if session cookie is available
    cookies = {}
    if STASH_SESSION_COOKIE:
        cookies[STASH_SESSION_COOKIE["Name"]] = STASH_SESSION_COOKIE["Value"]
    
    try:
        if not STASH_GRAPHQL_URL:
            raise Exception("Stash GraphQL URL not configured")
        
        response = requests.post(
            STASH_GRAPHQL_URL,
            json={"query": query, "variables": variables},
            headers=headers,
            cookies=cookies,
            timeout=10
        )
        response.raise_for_status()
        
        result = response.json()
        
        if "errors" in result:
            raise Exception(f"GraphQL errors: {result['errors']}")
        
        scene = result.get("data", {}).get("findScene")
        if not scene:
            raise Exception(f"Scene {scene_id} not found")
        
        files = scene.get("files", [])
        if not files:
            raise Exception(f"No files found for scene {scene_id}")
        
        file_path = files[0]["path"]
        basename = os.path.basename(file_path)
        log_info(f"Found file: {basename}")
        
        return {
            "id": scene["id"],
            "title": scene.get("title", "Untitled"),
            "file_path": file_path
        }
        
    except requests.exceptions.RequestException as e:
        raise Exception(f"Failed to query Stash API: {e}")


def trigger_stash_scan(file_path):
    """Trigger Stash to scan for the new subtitle file"""
    try:
        directory = os.path.dirname(file_path)
        log_info(f"Triggering Stash scan for: {directory}")
        
        mutation = """
            mutation MetadataScan($input: ScanMetadataInput!) {
                metadataScan(input: $input)
            }
        """
        
        variables = {
            "input": {
                "paths": [directory],
                "rescan": False,
                "scanGenerateCovers": True,
                "scanGeneratePreviews": True,
                "scanGenerateImagePreviews": False,
                "scanGenerateSprites": True,
                "scanGeneratePhashes": True,
                "scanGenerateThumbnails": False,
                "scanGenerateClipPreviews": False
            }
        }
        
        headers = {"Content-Type": "application/json"}
        if STASH_API_KEY:
            headers["ApiKey"] = STASH_API_KEY
        
        cookies = {}
        if STASH_SESSION_COOKIE:
            cookies[STASH_SESSION_COOKIE["Name"]] = STASH_SESSION_COOKIE["Value"]
        
        # Use the internal Stash URL (direct Docker network connection)
        # This uses the same connection as other GraphQL calls
        
        response = requests.post(
            STASH_GRAPHQL_URL,
            json={"query": mutation, "variables": variables},
            headers=headers,
            cookies=cookies,
            verify=False,  # Skip SSL verification for internal Docker calls
            timeout=30
        )
        
        response.raise_for_status()
        
        if response.text.strip():
            try:
                result = response.json()
                
                if "errors" in result:
                    log_warning(f"Scan returned errors: {result['errors']}")
                elif "data" in result and result["data"].get("metadataScan"):
                    task_id = result["data"]["metadataScan"]
                    log_info(f"✓ Stash scan triggered successfully (Task ID: {task_id})")
                else:
                    log_warning(f"Scan response missing expected data: {result}")
            except ValueError as e:
                log_warning(f"Could not parse scan response as JSON: {e}")
        else:
            log_warning("Scan returned empty response")
            
    except requests.exceptions.RequestException as e:
        log_warning(f"Could not trigger automatic scan: {e}")
        log_info("Subtitle saved successfully. Manual rescan may be needed to see it in Stash.")
    except Exception as e:
        log_warning(f"Scan trigger error: {e}")


def call_subgen_webhook(file_path, auto_fix_pipe_issues=False, create_backup=False):
    """Call Subgen /asr endpoint to generate subtitles for a single file"""
    basename = os.path.basename(file_path)
    log_info(f"Starting subtitle generation for: {basename}")
    log_info("Note: Processing time varies by video length (typically 1-10 minutes)")
    
    # Verify file exists in Stash container
    if not os.path.isfile(file_path):
        raise Exception(f"File not found in Stash container: {file_path}")
    
    # Check pipe compatibility and auto-fix if enabled
    remuxed_temp_file = None
    actual_file_to_upload = file_path
    
    if auto_fix_pipe_issues:
        log_info("Checking pipe compatibility...")
        is_compatible = check_pipe_compatibility(file_path)
        
        if not is_compatible:
            log_warning("File has pipe compatibility issues (moov atom positioning)")
            log_info("Auto-fix enabled: remuxing file to fix compatibility...")
            
            remuxed_temp_file = remux_for_pipe_compatibility(file_path, create_backup)
            
            if remuxed_temp_file:
                actual_file_to_upload = remuxed_temp_file
                log_info(f"Using remuxed file for upload")
            else:
                log_error("Remux failed, will attempt upload with original file anyway")
                actual_file_to_upload = file_path
        else:
            log_info("✓ File is pipe-compatible, no remux needed")
    
    # Use /asr endpoint - expects multipart file upload with 'audio_file' field
    webhook_url = f"{SUBGEN_WEBHOOK_URL}/asr"
    
    try:
        # Open and upload the actual file (original or remuxed)
        with open(actual_file_to_upload, 'rb') as f:
            files = {
                'audio_file': (os.path.basename(file_path), f, 'video/mp4')
            }
            # Subgen API parameters - MUST be query parameters, not form data
            params = {
                'language': 'en',      # Force English language
                'task': 'transcribe',  # Transcribe (not translate)
                'output': 'srt',       # SRT subtitle format
                'encode': True,        # Process the uploaded file
            }
            
            log_info("Uploading to Subgen and generating subtitles...")
            
            response = requests.post(
                webhook_url,
                files=files,
                params=params,  # Query parameters, not form data
                timeout=3600  # 1 hour timeout for very long videos (Subgen can take 5-10+ minutes for long files)
            )
        
        response.raise_for_status()
        
        # Get response body (should be SRT content)
        srt_content = response.text
        
        # Validate response content
        if not srt_content or len(srt_content) < 10:
            log_error("Subgen returned empty or invalid response")
            raise Exception("Subgen failed to generate subtitles - empty response received")
        
        # Save SRT file next to the ORIGINAL video file (not temp file)
        srt_file_path = os.path.splitext(file_path)[0] + ".eng.srt"
        
        try:
            with open(srt_file_path, 'w', encoding='utf-8') as f:
                f.write(srt_content)
            srt_filename = os.path.basename(srt_file_path)
            log_info(f"✓ Saved {srt_filename}")
        except Exception as e:
            log_error(f"Failed to save SRT file: {e}")
            raise Exception(f"Failed to save SRT file: {e}")
        
        # Trigger Stash to scan for the new subtitle file
        trigger_stash_scan(file_path)
        
        log_info("✓ Subtitle generation complete!")
        return {
            "success": True,
            "status_code": response.status_code,
            "srt_file": srt_file_path,
            "srt_size_bytes": len(srt_content)
        }
        
    except requests.exceptions.RequestException as e:
        raise Exception(f"Subgen webhook call failed: {e}")
    
    finally:
        # Clean up temporary remuxed file if it was created
        if remuxed_temp_file and os.path.exists(remuxed_temp_file):
            try:
                os.remove(remuxed_temp_file)
                log_debug(f"Cleaned up temp file: {os.path.basename(remuxed_temp_file)}")
            except Exception as e:
                log_warning(f"Could not delete temp file: {e}")


def get_subtitle_file_path(scene_id):
    """Get the subtitle file path for a scene, trying multiple extensions"""
    scene_data = query_scene_file_path(scene_id)
    video_path = scene_data["file_path"]
    
    # Build base path without extension
    base_path = os.path.splitext(video_path)[0]
    
    # Try multiple subtitle file extensions in priority order
    # 1. .eng.srt (preferred, what we create)
    # 2. .en.srt (alternative)
    # 3. .srt (fallback)
    extensions_to_try = [".eng.srt", ".en.srt", ".srt"]
    
    for ext in extensions_to_try:
        subtitle_path = f"{base_path}{ext}"
        if os.path.exists(subtitle_path):
            log_debug(f"Found subtitle file: {os.path.basename(subtitle_path)}")
            return subtitle_path
    
    # No existing file found - return the preferred extension for new files
    default_path = f"{base_path}.eng.srt"
    log_debug(f"No subtitle file found, will use: {os.path.basename(default_path)}")
    return default_path


def read_subtitle_file(scene_id):
    """Read subtitle file content for a scene"""
    try:
        # Query scene and build subtitle path (may fail if scene doesn't exist or GraphQL error)
        subtitle_path = get_subtitle_file_path(scene_id)
    except Exception as e:
        log_error(f"Failed to query scene or build subtitle path: {e}")
        return {
            "success": False,
            "error": f"Failed to get scene info: {str(e)}"
        }
    
    try:
        log_debug(f"Looking for subtitle file: {subtitle_path}")
        
        if not os.path.exists(subtitle_path):
            log_info(f"Subtitle file not found: {subtitle_path}")
            return {
                "success": False,
                "error": "Subtitle file not found",
                "file_path": subtitle_path
            }
        
        log_info(f"Reading subtitle file: {os.path.basename(subtitle_path)}")
        
        with open(subtitle_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        log_info(f"✓ Read {len(content)} characters from subtitle file")
        
        return {
            "success": True,
            "content": content,
            "file_path": subtitle_path,
            "file_size": len(content)
        }
        
    except Exception as e:
        log_error(f"Failed to read subtitle file: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def save_subtitle_file(scene_id, content):
    """Save subtitle file content for a scene"""
    try:
        # Query scene and build subtitle path (may fail if scene doesn't exist or GraphQL error)
        subtitle_path = get_subtitle_file_path(scene_id)
    except Exception as e:
        log_error(f"Failed to query scene or build subtitle path: {e}")
        return {
            "success": False,
            "error": f"Failed to get scene info: {str(e)}"
        }
    
    try:
        log_info(f"Saving subtitle file: {os.path.basename(subtitle_path)}")
        
        # Write the content
        with open(subtitle_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        log_info(f"✓ Saved {len(content)} characters to subtitle file")
        
        # Trigger Stash scan to update metadata
        # Get video path by querying scene again (more reliable than string replacement)
        scene_data = query_scene_file_path(scene_id)
        video_path = scene_data["file_path"]
        trigger_stash_scan(video_path)
        
        return {
            "success": True,
            "file_path": subtitle_path,
            "file_size": len(content)
        }
        
    except Exception as e:
        log_error(f"Failed to save subtitle file: {e}")
        return {
            "success": False,
            "error": str(e)
        }


def main():
    """Main entry point for Stash plugin task"""
    try:
        # Read input from stdin (Stash passes JSON input)
        input_data = json.loads(sys.stdin.read())
        
        # Log what we received (debug only)
        log_debug(f"Received input_data: {json.dumps(input_data, indent=2)}")
        
        # Extract server connection info
        server_conn = input_data.get("server_connection", {})
        scheme = server_conn.get("Scheme", "http")
        host = server_conn.get("Host", "localhost")
        port = server_conn.get("Port", 9999)
        
        # Build Stash GraphQL URL from server connection
        global STASH_GRAPHQL_URL, STASH_API_KEY
        STASH_GRAPHQL_URL = f"{scheme}://{host}:{port}/graphql"
        log_debug(f"Using Stash GraphQL URL: {STASH_GRAPHQL_URL}")
        
        global STASH_SESSION_COOKIE
        
        # Extract authentication from server connection
        if "ApiKey" in server_conn and server_conn["ApiKey"]:
            STASH_API_KEY = server_conn["ApiKey"]
        elif "SessionCookie" in server_conn and server_conn["SessionCookie"]:
            STASH_SESSION_COOKIE = server_conn["SessionCookie"]
        
        # Extract arguments from input
        args = input_data.get("args", {})
        log_debug(f"Parsed args: {args}")
        
        scene_id = args.get("scene_id")
        mode = args.get("mode", "generate")  # New: support different task modes
        log_debug(f"scene_id={scene_id}, mode={mode}")
        
        if not scene_id:
            raise ValueError("scene_id is required in args")
        
        # Set global DEBUG flag from args
        global DEBUG
        debug_logging = args.get("debug_logging", False)
        if isinstance(debug_logging, str):
            debug_logging = debug_logging.lower() in ('true', '1', 'yes')
        DEBUG = debug_logging
        
        # Handle different task modes
        if mode == "read_subtitle":
            # Read subtitle file
            result = read_subtitle_file(scene_id)
            log_debug(f"read_subtitle_file returned: {json.dumps(result)}")
            plugin_output = {
                "mode": "read_subtitle",
                "scene_id": scene_id,
                "result": result
            }
            
        elif mode == "save_subtitle":
            # Save subtitle file
            content = args.get("content")
            if not content:
                raise ValueError("content is required for save_subtitle mode")
            
            result = save_subtitle_file(scene_id, content)
            plugin_output = {
                "mode": "save_subtitle",
                "scene_id": scene_id,
                "result": result
            }
            
        else:
            # Default mode: Generate subtitles
            # Debug logging status is now visible from debug messages themselves
            
            # Get Subgen URL from args (passed from JavaScript), or use default
            global SUBGEN_WEBHOOK_URL
            if args.get("subgen_url"):
                SUBGEN_WEBHOOK_URL = args.get("subgen_url")
                log_info(f"Using custom Subgen URL: {SUBGEN_WEBHOOK_URL}")
            
            # Get settings from args (passed from JavaScript)
            # Note: Stash <0.23.0 passes booleans as strings, so we need to handle both
            auto_fix_pipe_issues = args.get("auto_fix_pipe_issues", False)
            create_backup = args.get("create_backup", False)
            
            # Convert string booleans to actual booleans (backward compatibility)
            if isinstance(auto_fix_pipe_issues, str):
                auto_fix_pipe_issues = auto_fix_pipe_issues.lower() in ('true', '1', 'yes')
            if isinstance(create_backup, str):
                create_backup = create_backup.lower() in ('true', '1', 'yes')
            
            if auto_fix_pipe_issues:
                log_info("Auto-fix pipe compatibility enabled")
                if create_backup:
                    log_info("Backup creation enabled")
            
            # Step 1: Query scene file path from Stash
            scene_data = query_scene_file_path(scene_id)
            
            # Step 2: Call Subgen webhook (with optional auto-fix and backup)
            webhook_result = call_subgen_webhook(
                scene_data["file_path"],
                auto_fix_pipe_issues=auto_fix_pipe_issues,
                create_backup=create_backup
            )
            
            # Return success response
            plugin_output = {
                "mode": "generate",
                "scene_id": scene_data["id"],
                "scene_title": scene_data["title"],
                "file_path": scene_data["file_path"],
                "subgen_response": webhook_result
            }
        
        # Wrap in PluginOutput structure for runPluginOperation
        output = {
            "output": plugin_output
        }
        
        log_debug(f"Final output before print: {json.dumps(output)}")
        print(json.dumps(output))
        log_debug("JSON printed to stdout, exiting with 0")
        sys.exit(0)
        
    except Exception as e:
        log_error(f"ERROR: {str(e)}")
        
        error_output = {
            "error": str(e)
        }
        
        print(json.dumps(error_output))
        sys.exit(1)


if __name__ == "__main__":
    main()
