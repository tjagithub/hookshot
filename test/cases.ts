// Ported from guardrails/test-bash-guard.sh: the baseline any hookshot port must match.

/** [command, expected rewrite]: exit 0 with updatedInput.command set. */
export const rewrites: Array<[string, string]> = [
  ['grep foo file', 'rg foo file'],
  ['cat x | grep foo', 'cat x | rg foo'],
  ['sudo grep -r a .', 'sudo rg a .'],
  ['ls && egrep a b', 'ls && rg a b'],
  ["echo 'a;b' ; grep x y", "echo 'a;b' ; rg x y"],
  ['grep -rn foo src', 'rg -n foo src'],
  ['grep -rniw TODO .', 'rg -n -i -w TODO .'],
  ["grep -rl --include='*.ts' foo src", "rg -l -g '*.ts' foo src"],
  ['grep -r --exclude-dir=node_modules x .', "rg -g '!node_modules' x ."],
  ['grep -h -A 3 x f', 'rg -I -A3 x f'],
  ['grep -C2 -L x f', 'rg -C2 --files-without-match x f'],
  ['fgrep -s a.b f', 'rg -F --no-messages a.b f'],
  ["grep 'a|b' f | wc -l", "rg 'a|b' f | wc -l"],
  ['xargs -0 grep a', 'xargs -0 rg a'],
  ['timeout 5 grep a f', 'timeout 5 rg a f'],
  ['nice -n 5 grep a f', 'nice -n 5 rg a f'],
  ['env -i FOO=1 grep a f', 'env -i FOO=1 rg a f'],
  ['sudo -u root grep -r a .', 'sudo -u root rg a .'],
  ["bash -c 'grep -rn a f'", "bash -c 'rg -n a f'"],
  ['find . -exec grep -l a {} +', 'find . -exec rg -l a {} +'],
  ['echo $(grep a f)', 'echo $(rg a f)'],
  ['echo `grep a f` <(grep b g)', 'echo `rg a f` <(rg b g)'],
  ['cat ü | grep -r x .', 'cat ü | rg x .'],
]

/** Rewrites that need jouet on PATH (sed -n 'A,Bp' FILE -> jouet read). */
export const jouetRewrites: Array<[string, string]> = [
  ["sed -n '10,20p' f", 'jouet read f --range 10:20'],
  ['sed -n 5p "a b.txt"', 'jouet read "a b.txt" --range 5:5'],
  ['cd x && sed -n 1,3p $F || echo no', 'cd x && jouet read $F --range 1:3 || echo no'],
  ['sed -n 1,2p a; grep -r x .', 'jouet read a --range 1:2; rg x .'],
]

/** Allowed and left exactly as is (exit 0, no output), with jouet on PATH. */
export const untouched: string[] = [
  'sed -n 1,5p f | wc -l',
  'x=$(sed -n 3p f)',
  'sed -n 1,5p f > out',
  'sed -n 1,5p a b',
  'sed -n 1,$p f',
  'sed -n 9,2p f',
  'sudo sed -n 1p f',
  "bash -c 'sed -n 1p f'",
]

/** Exit 2: denied. */
export const blocked: string[] = [
  'bash -c "grep a f"',
  "bash -c 'grep --include=*.ts a .'",
  "sh -c 'rm -rf ~'",
  'sudo rm -rf /',
  'xargs rm -rf ~',
  'grep -e a -e b f',
  'grep foo -r .',
  'grep -z a f',
  'zgrep a f.gz',
  'grep -rn foo . && rm -rf ~',
  'git push --force',
  'git push --force-with-lease origin x',
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -fr $HOME/',
  'rm -rf "/"',
  'echo a; rm -rf ~',
  "sed -i 's/a/b/' f",
  "sed -i.bak 's/a/b/' f",
  "sed -ni 's/a/b/p' f",
  'sed --in-place s/a/b/ f',
]

/** bash-guard allows these but must block them. Run as test.fails; once fixed, move them to `blocked`. */
export const knownGaps: Array<[why: string, command: string]> = [
  ['nested-script budget: the 17th script is never checked',
    `${"bash -c 'true'; ".repeat(16)}bash -c 'rm -rf ~'`],
  ['valid zsh that mvdan rejects is allowed unparsed', 'for f (a b) rm -rf ~'],
  ['an unparsed nested script is allowed', "bash -c 'for f (a b) rm -rf ~'"],
  ['zsh repeat is not a known wrapper', 'repeat 2 rm -rf ~'],
]

/** Exit 0 (may still be rewritten). */
export const allowed: string[] = [
  'command -v grep',
  "ssh host 'grep a f'",
  "sed -n '1,5p' f",
  "sed -e 's/a/b/' f",
  'sed --expression=s/a/b/ f',
  'echo sed -i',
  'git grep foo',
  'rg foo',
  "rg -i 'coreutils|grep|sed' file",
  "echo 'a;grep b'",
  'brew link --overwrite hf',
  'rm -rf /tmp/foo',
  'rm file',
  'rm -r build',
]
