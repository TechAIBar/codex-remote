// 用法: node inspect.js ThreadListParams ThreadListResponse ...
// 打印 v2 schema 里指定类型的字段摘要，方便对照协议。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "v2");

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
  } catch {
    return null;
  }
}

function typeOf(v) {
  if (v.$ref) return "-> " + v.$ref.split("/").pop();
  if (v.type) return Array.isArray(v.type) ? v.type.join("|") : v.type;
  if (v.anyOf) return "anyOf";
  if (v.oneOf) return "oneOf";
  return "?";
}

function show(schema, defs, ind, depth) {
  if (!schema || depth > 4) return;
  if (schema.$ref) {
    const rn = schema.$ref.split("/").pop();
    console.log(ind + "-> " + rn);
    if (defs[rn]) show(defs[rn], defs, ind + "  ", depth + 1);
    return;
  }
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      const req = (schema.required || []).includes(k) ? "*" : "";
      let line = ind + k + req + ": " + typeOf(v);
      if (v.enum) line += " enum[" + v.enum.join(",") + "]";
      if (v.items) line += " items " + typeOf(v.items);
      console.log(line);
      if (v.$ref && defs[v.$ref.split("/").pop()]) show(defs[v.$ref.split("/").pop()], defs, ind + "    ", depth + 1);
      if (v.items && v.items.$ref && defs[v.items.$ref.split("/").pop()]) show(defs[v.items.$ref.split("/").pop()], defs, ind + "    ", depth + 1);
      if (v.anyOf) show({ anyOf: v.anyOf }, defs, ind + "    ", depth + 1);
    }
  }
  const alts = schema.oneOf || schema.anyOf;
  if (alts) {
    alts.forEach((x, i) => {
      if (x.$ref) {
        console.log(ind + "[" + i + "] -> " + x.$ref.split("/").pop());
        const rn = x.$ref.split("/").pop();
        if (defs[rn] && depth < 2) show(defs[rn], defs, ind + "    ", depth + 1);
      } else if (x.properties) {
        console.log(ind + "[" + i + "]");
        show(x, defs, ind + "  ", depth + 1);
      } else {
        console.log(ind + "[" + i + "] " + typeOf(x) + (x.enum ? " enum[" + x.enum.slice(0, 8).join(",") + "]" : ""));
      }
    });
  }
}

for (const name of process.argv.slice(2)) {
  const o = load(name);
  console.log("=== " + name);
  if (!o) {
    console.log("  (missing)");
    continue;
  }
  show(o, o.definitions || o.$defs || {}, "  ", 0);
}
