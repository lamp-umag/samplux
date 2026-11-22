cmake_minimum_required(VERSION 3.22)
project(samplux_lab CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(oboe REQUIRED CONFIG)

add_library(samplux_lab SHARED
  core/samplux_lab.cpp
  android/jni_bridge.cpp
)
target_include_directories(samplux_lab PRIVATE core android)
target_link_libraries(samplux_lab oboe::oboe log android)
