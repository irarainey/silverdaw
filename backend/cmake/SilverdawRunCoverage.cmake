# Runs the backend test binary under OpenCppCoverage and writes an HTML +
# Cobertura report. Used by the SilverdawBackendCoverage target on MSVC.
#
# OpenCppCoverage attaches as a debugger, so a Debug JUCE build hits a benign
# breakpoint (jassert / leak detector) and OpenCppCoverage returns that stop
# code even though every test passed and the report was written. We therefore
# treat "report produced" as success rather than the process exit code.
#
# Args (via -D): OPENCPPCOVERAGE, TEST_EXECUTABLE, SOURCE_DIR, OUTPUT_DIR

foreach(_var OPENCPPCOVERAGE TEST_EXECUTABLE SOURCE_DIR OUTPUT_DIR)
    if(NOT DEFINED ${_var})
        message(FATAL_ERROR "SilverdawRunCoverage: ${_var} is required")
    endif()
endforeach()

file(MAKE_DIRECTORY "${OUTPUT_DIR}")
file(TO_NATIVE_PATH "${SOURCE_DIR}" _native_sources)
set(_html "${OUTPUT_DIR}/html")
set(_cobertura "${OUTPUT_DIR}/cobertura.xml")

execute_process(
    COMMAND "${OPENCPPCOVERAGE}"
        --quiet
        --sources "${_native_sources}"
        --excluded_sources "tests"
        --excluded_sources "_deps"
        --excluded_sources "third_party"
        --modules "SilverdawBackendTests.exe"
        --export_type "html:${_html}"
        --export_type "cobertura:${_cobertura}"
        -- "${TEST_EXECUTABLE}"
    RESULT_VARIABLE _code
)

if(NOT EXISTS "${_cobertura}")
    message(FATAL_ERROR "OpenCppCoverage produced no report (process exit ${_code})")
endif()

message(STATUS "Backend coverage: ${_html}/index.html  (${_cobertura})")
