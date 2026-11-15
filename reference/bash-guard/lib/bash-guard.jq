# bash-guard.jq: input is `shfmt --to-json` of one command line. Output lines (tab-separated):
#   D <message>            deny the call
#   E <start> <end> <b64> <note>  replace bytes [start,end) of the script with the decoded text
#   N <offset|-> <b64>     nested script (bash -c ...) to parse again; offset is where it starts
#                          in this script when it can be edited in place, else "-"

def unq: gsub("\\\\(?<c>.)"; .c);

# Literal text of a word, or null when it depends on a substitution. $VAR renders as "$VAR".
def lit:
  def part:
    if .Type == "Lit" then .Value | unq
    elif .Type == "SglQuoted" then .Value
    elif .Type == "DblQuoted" then [.Parts[]? | part] | if any(. == null) then null else join("") end
    elif .Type == "ParamExp" then "$" + (.Param.Value // "")
    else null end;
  [.Parts[] | part] | if any(. == null) then null else join("") end;

def words:
  [.Args[]? | {t: lit, s: .Pos.Offset, e: .End.Offset, q: .Parts[0].Type,
    sgl: ((.Parts | length) == 1 and .Parts[0].Type == "SglQuoted")}];

def base: split("/") | last;

# Drop leading flags. $v: letters that take a value (in the next word when last in a cluster).
def skipflags($v; $assign):
  if length == 0 then .
  elif .[0].t == "--" then .[1:]
  elif $assign and ((.[0].t // "") | test("^[A-Za-z_][A-Za-z0-9_]*=")) then .[1:] | skipflags($v; $assign)
  elif (.[0].t // "") | test("^--.") then .[1:] | skipflags($v; $assign)
  elif (.[0].t // "") | test("^-.") then
    (.[0].t[1:] | split("")) as $cs
    | (first(range($cs | length) as $j | select($v | index($cs[$j])) | $j) // null) as $k
    | (if $k != null and $k == ($cs | length) - 1 then .[2:] else .[1:] end)
    | skipflags($v; $assign)
  else . end;

def wrappers: {sudo: "ugpCDhrtUT", doas: "uC", xargs: "ILnPsdEJRSa", gxargs: "ILnPsdEJRSa",
  nice: "n", nohup: "", builtin: "", noglob: "", nocorrect: "", exec: "a", stdbuf: "ioe", env: "uCPS"};

# Words of one call -> {cmd: words} for each command it runs, or {nested: {script, base}}.
def resolve:
  if length == 0 then empty
  elif .[0].t == null then {cmd: .}
  else (.[0].t | base) as $h
  | if wrappers[$h] != null then .[1:] | skipflags(wrappers[$h]; $h == "env") | resolve
    elif $h | IN("timeout", "gtimeout") then .[1:] | skipflags("sk"; false) | .[1:] | resolve
    elif $h == "command" then
      if any(.[1:][]; .t | IN("-v", "-V")) then empty else .[1:] | skipflags(""; false) | resolve end
    elif $h == "find" then
      {cmd: .},
      (. as $w | range(length) as $i
        | select(($w[$i].t // "") | IN("-exec", "-execdir", "-ok", "-okdir"))
        | $w[$i + 1:] | (map(.t | IN(";", "+")) | index(true)) as $j
        | (if $j then .[:$j] else . end) | resolve)
    elif $h | IN("bash", "sh", "zsh", "dash", "ksh") then
      {cmd: .},
      (. as $w | (map((.t // "") | test("^-[a-zA-Z]*c[a-zA-Z]*$")) | index(true)) as $i
        | select($i != null) | $w[$i + 1] | select(. != null and .t != null)
        | {nested: {script: .t, base: (if .sgl then .s + 1 else null end)}})
    elif $h == "eval" then {nested: {script: ([.[1:][] | .t // ""] | join(" ")), base: null}}
    else {cmd: .} end
  end;

# grep flag -> rg flag ("" = drop). r is rg --replace, h is --help, L follows links: all differ.
def short: {r: "", R: "", E: "", s: "--no-messages", h: "-I", L: "--files-without-match"}
  + ([("nilcvwoFHqxPab" | split(""))[] | {(.): ("-" + .)}] | add);
def long: {"--recursive": "", "--extended-regexp": "", "--ignore-case": "-i", "--line-number": "-n",
  "--count": "-c", "--files-with-matches": "-l", "--files-without-match": "--files-without-match",
  "--invert-match": "-v", "--word-regexp": "-w", "--only-matching": "-o", "--fixed-strings": "-F",
  "--perl-regexp": "-P", "--quiet": "-q", "--silent": "-q", "--no-messages": "--no-messages",
  "--with-filename": "-H", "--no-filename": "-I", "--line-regexp": "-x"};

def tr($ws; $i; $out):
  if $i >= ($ws | length) then {out: $out, i: $i}
  else ($ws[$i].t) as $f
  | if $f == null or ($f | test("^-.") | not) then {out: $out, i: $i}
    elif $f == "--" then {out: ($out + ["--"]), i: ($i + 1)}
    elif $f | test("^--(include|exclude|exclude-dir)=") then
      ($f | capture("^--(?<k>[a-z-]+)=(?<v>.*)$")) as $c
      | tr($ws; $i + 1; $out + ["-g " + ((if $c.k == "include" then "" else "!" end) + $c.v | @sh)])
    elif $f | test("^--colou?r(=(never|always|auto))?$") then tr($ws; $i + 1; $out + [$f])
    elif $f | startswith("--") then
      (long[$f] // error("flag")) as $r | tr($ws; $i + 1; $out + (if $r == "" then [] else [$r] end))
    else
      ($f[1:] | split("")) as $cs
      | (first(range($cs | length) as $j | select($cs[$j] | IN("A", "B", "C", "m")) | $j) // null) as $k
      | [(if $k == null then $cs else $cs[:$k] end)[] | (short[.] // error("flag")) | select(. != "")] as $o
      | if $k == null then tr($ws; $i + 1; $out + $o)
        else ($cs[$k + 1:] | join("")) as $v
        | if $v != "" then
            ($v | test("^[0-9]+$") or error("flag")) as $_ | tr($ws; $i + 1; $out + $o + ["-\($cs[$k])\($v)"])
          else
            (($ws[$i + 1].t // "") | test("^[0-9]+$") or error("flag")) as $_
            | tr($ws; $i + 2; $out + $o + ["-\($cs[$k])\($ws[$i + 1].t)"])
          end
        end
    end
  end;

def grep_edit($ws):
  ($ws | length) as $n
  | tr($ws; 1; if ($ws[0].t | base) == "fgrep" then ["-F"] else [] end) as $r
  | if ($r.out | any(. == "--") | not) and any($ws[$r.i + 1:][]; (.t // "") | test("^-.")) then error("flag")
    else {s: $ws[0].s, e: (if $r.i < $n then $ws[$r.i].s else $ws[-1].e end),
      t: ((["rg"] + $r.out | join(" ")) + (if $r.i < $n then " " else "" end))} end;

def check:
  .cmd as $ws
  | if $ws[0].t == null then empty
    else ($ws[0].t | base) as $h
    | if $h | IN("grep", "egrep", "fgrep") then
        try (grep_edit($ws) | "E\t\(.s)\t\(.e)\t\(.t | @base64)\tgrep -> rg")
        catch "D\tgrep is not allowed here; use rg (e.g. rg PATTERN [path], rg --files -g '<glob>')."
      elif $h | IN("zgrep", "zegrep", "zfgrep") then "D\tgrep is not allowed here; use rg (e.g. rg -z PATTERN file.gz)."
      elif $h | IN("sed", "gsed") then
        if any($ws[1:][]; (.t // "") | test("^--in-place") or test("^-[a-zA-Z]*i")) then
          "D\tsed -i differs between BSD and GNU. Use the Edit tool or perl -pi -e."
        else empty end
      elif $h == "rm" and any($ws[1:][]; (.t // "") | . == "--recursive" or test("^-[^-]*[rR]")) then
        $ws[1:][] | select((.t // "") | IN("/", "/*", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*"))
        | "D\trefusing recursive rm on '\(.t)'. Name the exact directory instead."
      else empty end
    end;

# Calls whose output reaches the terminal: not piped, captured, redirected, backgrounded or negated.
def standalone:
  .[]? | select((.Redirs // []) == [] and ((.Background // false) | not) and ((.Negated // false) | not))
  | .Cmd
  | if .Type == "BinaryCmd" and (.Op | IN("&&", "||")) then [.X, .Y] | standalone
    elif .Type == "CallExpr" then .
    else empty end;

# sed -n 'A,Bp' FILE -> jouet read FILE --range A:B (same lines, numbered). FILE keeps its own quoting.
def sed_read:
  select(((.Assigns // []) | length) == 0) | words as $ws
  | select(($ws | length) == 4 and $ws[0].t == "sed" and $ws[1].t == "-n"
      and ($ws[3].t // "-" | startswith("-") | not))
  | ($ws[2].t // "" | capture("^(?<a>[0-9]+)(,(?<b>[0-9]+))?p$")) as $m
  | ($m.a | tonumber) as $a | (($m.b // $m.a) | tonumber) as $b
  | select($a >= 1 and $a <= $b)
  | "E\t\($ws[0].s)\t\($ws[3].s)\t\("jouet read " | @base64)\tsed -n -> jouet read",
    "E\t\($ws[3].e)\t\($ws[3].e)\t\(" --range \($a):\($b)" | @base64)\tsed -n -> jouet read";

(if $jouet == "1" and $top == "1" then .Stmts | standalone | sed_read else empty end),
([.. | objects | select(.Type? == "CallExpr")] as $calls
| ($calls[] | words[] | select(.q == "Lit" and ((.t // "") | startswith("--force")))
    | "D\t--force* flags are not allowed. Find the non-forced way, or ask the user to run it themselves."),
  ($calls[] | words | resolve
    | if .nested then "N\t\(.nested.base // "-")\t\(.nested.script | @base64)" else check end))
