cmake_minimum_required(VERSION 3.22)
project(samplux_native_tests CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(test_samplux_core
  test_samplux_core.cpp
  ../core/samplux_lab.cpp
)
target_include_directories(test_samplux_core PRIVATE ../core)

enable_testing()
add_test(NAME samplux_core COMMAND test_samplux_core)
