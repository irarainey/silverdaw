# Supply a valid port so exit 2 cannot come from missing port configuration.
# Token rejection happens before the backend binds or opens an audio device.
string(RANDOM LENGTH 4 ALPHABET "0123456789" port_suffix)
set(port "5${port_suffix}")
unset(ENV{SILVERDAW_LOG_DIR})
unset(ENV{SILVERDAW_DIAG_DIR})

function(expect_token_rejection scenario)
    execute_process(
        COMMAND "${BACKEND}" --port "${port}" ${ARGN}
        RESULT_VARIABLE result
        ERROR_VARIABLE stderr
        TIMEOUT 10)
    if(NOT result STREQUAL "2" OR NOT stderr MATCHES "token")
        message(FATAL_ERROR "${scenario}: expected exit 2 and a token diagnostic; got '${result}'.\n${stderr}")
    endif()
endfunction()

unset(ENV{SILVERDAW_BRIDGE_TOKEN})
expect_token_rejection("Missing environment token")
set(ENV{SILVERDAW_BRIDGE_TOKEN} "   ")
expect_token_rejection("Whitespace-only environment token")

# An explicit but incomplete CLI option must not fall back to the environment.
set(ENV{SILVERDAW_BRIDGE_TOKEN} "startup-test-fixture")
expect_token_rejection("Empty CLI override" --token=)
expect_token_rejection("Missing CLI value" --token)
