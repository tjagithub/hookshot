// Node-API wrapper over the c-archive build: parse(src: string, dialect = -1): string | null.
#include <node_api.h>
#include <stdlib.h>
#include "libhsparse.h"

#define CHECK(call) if ((call) != napi_ok) { napi_throw_error(env, NULL, #call " failed"); return NULL; }

static napi_value Parse(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 1) { napi_throw_type_error(env, NULL, "parse(src, dialect?)"); return NULL; }

  size_t len;
  CHECK(napi_get_value_string_utf8(env, argv[0], NULL, 0, &len));
  char *src = malloc(len + 1);
  if (!src) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  napi_status st = napi_get_value_string_utf8(env, argv[0], src, len + 1, &len);
  if (st != napi_ok) { free(src); napi_throw_error(env, NULL, "bad string"); return NULL; }

  int32_t dialect = -1;
  if (argc > 1) napi_get_value_int32(env, argv[1], &dialect);

  char *json = hs_parse(src, (int)len, dialect);
  free(src);
  napi_value out;
  if (!json) { CHECK(napi_get_null(env, &out)); return out; }
  st = napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &out);
  hs_free(json);
  CHECK(st);
  return out;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  CHECK(napi_create_function(env, "parse", NAPI_AUTO_LENGTH, Parse, NULL, &fn));
  CHECK(napi_set_named_property(env, exports, "parse", fn));
  return exports;
}
