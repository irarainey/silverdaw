function(silverdaw_patch_ixwebsocket source_dir)
    set(socket_source "${source_dir}/ixwebsocket/IXSocket.cpp")
    file(READ "${socket_source}" content)
    set(original "bool readyToRead = false;\n        return poll(readyToRead, timeoutMs, _sockfd, _selectInterrupt);")
    set(patched "bool readyToRead = false;\n        return poll(readyToRead, timeoutMs, _sockfd, nullptr);")

    string(FIND "${content}" "${patched}" patched_at)
    if(NOT patched_at EQUAL -1)
        return()
    endif()
    string(FIND "${content}" "${original}" original_at)
    if(original_at EQUAL -1)
        message(FATAL_ERROR "IXWebSocket socket polling changed; review the Windows read/write notification fix")
    endif()

    # Concurrent WSAEventSelect calls replace each other's socket subscription.
    # Use the select fallback for bounded write waits, leaving read events intact.
    string(REPLACE "${original}" "${patched}" content "${content}")
    file(WRITE "${socket_source}" "${content}")
endfunction()
