#!/data/data/com.termux/files/usr/bin/bash
# termux-pi 0.1.0 — a small, scoped installer for native Termux.
set -Eeuo pipefail
umask 077

readonly APP_VERSION='0.1.0'
readonly PI_VERSION='1.5.0'
readonly PI_PACKAGE='@earendil-works/pi-coding-agent'
readonly DEFAULT_SOURCE_URL='https://github.com/shigenben/termux-pi/archive/refs/tags/v0.1.0.tar.gz'
readonly MANAGED_MARKER='termux-pi-managed-v1'

yes=0 skip_configure=0 no_link=0 source_dir='' source_url="$DEFAULT_SOURCE_URL" source_url_set=0 root_arg=''
stage='' lock_dir='' have_lock=0 newly_installed=0

usage() {
  cat <<'USAGE'
termux-pi 0.1.0 安装器（仅原生 Termux）
用法：bash install.sh [选项]
  --yes                 同意安装明确列出的依赖包，适合非交互调用
  --skip-configure      安装后暂不填写模型设置
  --no-link             不在 $PREFIX/bin 添加 pi-termux 命令
  --root ABSOLUTE_PATH  指定真实 $HOME 下的独立安装目录
  --source-dir DIR      使用本地源码及 app-manifest.sha256
  --source-url HTTPS_URL 下载源码压缩包（默认固定 v0.1.0 tag）
  --help                显示帮助
不会升级整个 Termux 环境。重复安装保留 config、private 和 projects。
USAGE
}
die() { printf '错误[%s]：%s\n' "$1" "$2" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die argument "$1 缺少参数"; }
while (($#)); do
  case "$1" in
    --yes) yes=1; shift ;;
    --skip-configure) skip_configure=1; shift ;;
    --no-link) no_link=1; shift ;;
    --root) need_value "$@"; root_arg=$2; shift 2 ;;
    --source-dir) need_value "$@"; source_dir=$2; shift 2 ;;
    --source-url) need_value "$@"; source_url=$2; source_url_set=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die argument "未知选项：$1（查看 --help）" ;;
  esac
done
[[ -z $source_dir || $source_url_set == 0 ]] || die argument '--source-dir 与 --source-url 不能同时指定。'

# Do this before package management, network access or creating directories.
[[ $(id -u) != 0 ]] || die environment '请在普通 Termux 会话运行，不要使用 root/su。'
[[ $(uname -o 2>/dev/null || true) == Android ]] || die environment '只支持 Android 上的原生 Termux；不支持电脑 Linux、proot 或容器。'
[[ -n ${PREFIX:-} && -n ${HOME:-} && -d $PREFIX/bin && -d $HOME ]] || die environment '缺少有效的 Termux PREFIX/HOME。'
[[ $PREFIX == */com.termux/files/usr ]] || die environment 'PREFIX 不是官方 Termux 的原生目录。'
[[ -x $PREFIX/bin/apt-get ]] || die environment '找不到原生 Termux apt-get。'
command -v realpath >/dev/null || die environment '缺少 realpath；请先用 Termux pkg 安装 coreutils。'
home_real=$(cd -- "$HOME" && pwd -P)
prefix_real=$(cd -- "$PREFIX" && pwd -P)
[[ $home_real == "${prefix_real%/usr}/home" ]] || die environment 'HOME 与原生 Termux PREFIX 不匹配。'
[[ -z ${PROOT_TMP_DIR:-} && -z ${PROOT_LOADER:-} ]] || die environment '请退出 proot 后在原生 Termux 运行。'
root=${root_arg:-"$home_real/.termux-pi"}
[[ $root == /* && $root != *$'\n'* && $root != *$'\r'* ]] || die root '安装目录必须是绝对路径。'
[[ ! $root =~ (^|/)\.\.?(/|$) && $root != */ ]] || die root '安装目录不能包含 .、.. 或末尾斜线。'
[[ $root == "$home_real/"* && $root != "$home_real/" ]] || die root '安装目录必须位于真实 HOME 内，不能使用 HOME 本身。'
[[ $(realpath -m -- "$root") == "$root" ]] || die root '安装目录必须是规范路径，且不能经过符号链接。'
probe=$root
while [[ $probe != "$home_real" ]]; do
  [[ ! -L $probe ]] || die root '安装目录及其父目录不能使用符号链接。'
  probe=${probe%/*}
done
[[ ! -e $root || -d $root ]] || die root '安装目标已存在且不是目录。'
if [[ -e $root/.termux-pi-managed || -L $root/.termux-pi-managed ]]; then
  [[ -f $root/.termux-pi-managed && ! -L $root/.termux-pi-managed && $(cat -- "$root/.termux-pi-managed") == "$MANAGED_MARKER" ]] || die ownership '安装标记不匹配；不会修改这个目录。'
elif [[ -d $root && -n $(find "$root" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  die ownership '目标目录非空且不属于 termux-pi；请选择新的独立目录。'
fi
for component in bin releases runtime; do
  [[ ! -L $root/$component && ( ! -e $root/$component || -d $root/$component ) ]] || die ownership "受管理路径 $component 不是普通目录。"
done
if [[ -e $root/current && ! -L $root/current ]]; then die ownership 'current 已存在且不是受管理的符号链接。'; fi
if [[ -L $root/current ]]; then
  current_target=$(readlink -- "$root/current")
  [[ $current_target =~ ^releases/[0-9]+\.[0-9]+\.[0-9]+$ ]] || die ownership 'current 指向非受管理路径。'
fi
if ((!no_link)); then
  command_link="$prefix_real/bin/pi-termux"
  if [[ -e $command_link || -L $command_link ]]; then
    [[ -L $command_link && $(readlink -- "$command_link") == "$root/bin/pi-termux" ]] || die command 'PREFIX/bin/pi-termux 已存在且不属于此安装目录；未覆盖。可用 --no-link 安装。'
  fi
fi

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n $stage && $stage == "$root/.staging."* && -d $stage && ! -L $stage ]]; then rm -rf -- "$stage"; fi
  if ((have_lock)); then rmdir -- "$lock_dir" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Reserve enough room for npm's temporary tree and the installed runtime.
available_kb=$(df -Pk -- "$home_real" | awk 'END { print $4 }')
[[ $available_kb =~ ^[0-9]+$ && $available_kb -ge 524288 ]] || die disk 'HOME 可用空间不足 512 MiB。请先自行清理空间。'
if [[ ! -d $root ]]; then mkdir -p -- "$root"; fi
lock_dir="$root/.install-lock"
mkdir -- "$lock_dir" 2>/dev/null || die lock '另一个安装进程可能正在运行。确认没有安装进程后，才可手动移除 .install-lock 空目录。'
have_lock=1
printf '%s\n' "$MANAGED_MARKER" > "$root/.termux-pi-managed"
stage=$(mktemp -d "$root/.staging.XXXXXXXX")

node_is_supported() {
  [[ -x $PREFIX/bin/node ]] && "$PREFIX/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1
}
missing=0
for tool in node npm git rg fd curl tar; do command -v "$tool" >/dev/null || missing=1; done
node_is_supported || missing=1
if ((missing)); then
  say '需要安装/更新这些 Termux 包：nodejs npm git ripgrep fd curl tar（不执行全环境 upgrade）。'
  if ((!yes)); then
    [[ -r /dev/tty && -w /dev/tty ]] || die noninteractive '请在终端交互运行，或传 --yes 同意安装上述依赖。'
    printf '继续？[y/N] ' > /dev/tty
    answer=''; read -r answer < /dev/tty || true
    [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || die cancelled '已取消，未安装依赖。'
  fi
  "$PREFIX/bin/apt-get" update
  "$PREFIX/bin/apt-get" install -y --no-install-recommends nodejs npm git ripgrep fd curl tar
fi
for tool in node npm git rg fd curl tar sha256sum; do command -v "$tool" >/dev/null || die dependencies "安装后仍缺少 $tool。"; done
node_is_supported || die node '需要 Node.js >= 22.19；请检查 Termux 软件源中的 nodejs 版本。'

safe_payload_path() {
  [[ $1 =~ ^(app|example)/[A-Za-z0-9_.\/-]+$ && ! $1 =~ (^|/)\.\.?(/|$) && $1 != */ && $1 != *//* ]] || return 1
  case "$1" in
    app/*.mjs|app/*.json|app/*.md|app/*.txt|example/*.js|example/*.json|example/*.md) return 0 ;;
    *) return 1 ;;
  esac
}
declare -a payload_paths=()
declare -A payload_seen=()
read_manifest() {
  local manifest=$1 line hash path
  [[ -f $manifest && ! -L $manifest ]] || die integrity '缺少普通文件 app-manifest.sha256。请先运行构建脚本。'
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([0-9a-f]{64})\ \ (.+)$ ]] || die integrity '校验清单格式无效。'
    hash=${BASH_REMATCH[1]}; path=${BASH_REMATCH[2]}
    safe_payload_path "$path" || die integrity '校验清单包含不允许的路径或扩展名。'
    [[ -z ${payload_seen[$path]+present} ]] || die integrity '校验清单含重复文件。'
    payload_seen[$path]=$hash; payload_paths+=("$path")
  done < "$manifest"
  [[ ${#payload_paths[@]} -gt 0 && -n ${payload_seen[app/cli.mjs]+present} ]] || die integrity '校验清单缺少 app/cli.mjs。'
}
check_file_ancestors() {
  local base=$1 path=$2 probe="$1/$2"
  while [[ $probe != "$base" ]]; do
    [[ ! -L $probe ]] || die integrity '源码文件或父目录含符号链接。'
    probe=${probe%/*}
  done
  [[ -f $base/$path ]] || die integrity '校验清单中的文件缺失或不是普通文件。'
}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -z $source_dir && $source_url_set == 0 && -d $script_dir/app ]]; then source_dir=$script_dir; fi
if [[ -n $source_dir ]]; then
  [[ -d $source_dir && ! -L $source_dir ]] || die source '本地源码目录不存在或是符号链接。'
  source_dir=$(cd -- "$source_dir" && pwd -P)
  read_manifest "$source_dir/app-manifest.sha256"
else
  [[ $source_url == https://* && $source_url != *$'\n'* ]] || die source '下载地址必须使用 HTTPS。'
  say '下载固定版本的 termux-pi 源码……'
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --output "$stage/source.tar.gz" "$source_url"
  # Extract named, regular files only. Never unpack an archive wholesale.
  tar -tzf "$stage/source.tar.gz" > "$stage/archive-list"
  mapfile -t manifest_members < <(sed -n '\|^[A-Za-z0-9_.-]*/app-manifest\.sha256$|p' "$stage/archive-list")
  [[ ${#manifest_members[@]} == 1 ]] || die archive '源码包必须恰有一个顶层目录及校验清单。'
  archive_prefix=${manifest_members[0]%/app-manifest.sha256}
  [[ $archive_prefix == "termux-pi-$APP_VERSION" ]] || die archive '源码包顶层目录与固定版本不匹配。'
  source_dir="$stage/source"
  mkdir -- "$source_dir"
  extract_regular() {
    local path=$1 member="$archive_prefix/$1" listing
    [[ $(awk -v expected="$member" '$0 == expected {n++} END {print n+0}' "$stage/archive-list") == 1 ]] || die archive '压缩包缺少文件或含重复文件。'
    listing=$(tar -tvzf "$stage/source.tar.gz" -- "$member")
    [[ $listing == -* && $listing != *$'\n'* ]] || die archive '压缩包载荷必须是普通文件，不能是链接。'
    tar -xzf "$stage/source.tar.gz" --no-same-owner --no-same-permissions --keep-old-files --strip-components=1 -C "$source_dir" -- "$member"
  }
  extract_regular app-manifest.sha256
  read_manifest "$source_dir/app-manifest.sha256"
  for path in "${payload_paths[@]}"; do extract_regular "$path"; done
fi
for path in "${payload_paths[@]}"; do check_file_ancestors "$source_dir" "$path"; done
(cd -- "$source_dir" && sha256sum --check --strict --status app-manifest.sha256) || die integrity '源码 SHA-256 校验失败；没有替换现有版本。'

release="$root/releases/$APP_VERSION"
runtime="$root/runtime"
runtime_ok() {
  local component probe="$runtime"
  [[ -d $runtime && ! -L $runtime && -f $runtime/node_modules/$PI_PACKAGE/package.json && ! -L $runtime/node_modules/$PI_PACKAGE/package.json && -f $runtime/node_modules/$PI_PACKAGE/dist/bundle/cli.js ]] || return 1
  for component in node_modules @earendil-works pi-coding-agent dist bundle; do
    probe="$probe/$component"
    [[ -d $probe && ! -L $probe ]] || return 1
  done
  [[ $(realpath -e -- "$runtime/node_modules/$PI_PACKAGE/dist/bundle/cli.js") == "$runtime/"* ]] || return 1
  "$PREFIX/bin/node" -e 'const fs=require("node:fs");try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(p.name===process.argv[2]&&p.version===process.argv[3]?0:1)}catch{process.exit(1)}' "$runtime/node_modules/$PI_PACKAGE/package.json" "$PI_PACKAGE" "$PI_VERSION"
}
if [[ -e $runtime ]]; then
  runtime_ok || die runtime '现有 runtime 的固定版本或文件不匹配。已保留原目录；请移到新的独立 --root 安装，或先人工检查。'
  say "保留已安装的 Pi $PI_VERSION runtime。"
else
  say "安装固定 Pi $PI_VERSION（npm --ignore-scripts）……"
  mkdir -- "$stage/runtime"
  npm install --prefix "$stage/runtime" --ignore-scripts --no-audit --no-fund --save-exact "$PI_PACKAGE@$PI_VERSION"
  saved_runtime=$runtime; runtime="$stage/runtime"
  runtime_ok || die runtime 'npm 返回后仍未找到预期的 Pi 固定版本与 CLI；没有发布残缺 runtime。'
  runtime=$saved_runtime
  mv -- "$stage/runtime" "$runtime"
fi
mkdir -p -- "$root/releases" "$root/bin"
if [[ -e $release || -L $release ]]; then
  [[ -d $release && ! -L $release && -f $release/app-manifest.sha256 && ! -L $release/app-manifest.sha256 ]] || die release '已存在的版本目录不完整；未覆盖。'
  cmp -s -- "$source_dir/app-manifest.sha256" "$release/app-manifest.sha256" || die release '同一版本已有不同的载荷；请发布新版本，不能覆盖。'
  for path in "${payload_paths[@]}"; do check_file_ancestors "$release" "$path"; done
  (cd -- "$release" && sha256sum --check --strict --status app-manifest.sha256) || die release '已安装文件校验失败；未覆盖或删除。'
  say "保留已校验的 termux-pi $APP_VERSION 版本。"
else
  mkdir -- "$stage/release"
  for path in "${payload_paths[@]}"; do
    mkdir -p -- "$stage/release/${path%/*}"
    cp -- "$source_dir/$path" "$stage/release/$path"
    chmod 600 -- "$stage/release/$path"
  done
  cp -- "$source_dir/app-manifest.sha256" "$stage/release/app-manifest.sha256"
  mv -- "$stage/release" "$release"
  newly_installed=1
fi

wrapper="$root/bin/pi-termux"
if [[ -e $wrapper || -L $wrapper ]]; then
  [[ -f $wrapper && ! -L $wrapper ]] && head -n 2 -- "$wrapper" | tail -n 1 | grep -Fxq '# termux-pi managed wrapper v1' || die ownership 'bin/pi-termux 不是本安装器管理的文件。'
fi
{
  printf '#!%s/bin/bash\n# termux-pi managed wrapper v1\n' "$prefix_real"
  printf 'export TERMUX_PI_HOME=%q\n' "$root"
  printf 'exec %q %q "$@"\n' "$prefix_real/bin/node" "$root/current/app/cli.mjs"
} > "$stage/pi-termux"
chmod 700 -- "$stage/pi-termux"
mv -f -- "$stage/pi-termux" "$wrapper"
ln -s -- "releases/$APP_VERSION" "$stage/current"
mv -Tf -- "$stage/current" "$root/current"
if ((!no_link)); then
  command_link="$prefix_real/bin/pi-termux"
  if [[ -e $command_link || -L $command_link ]]; then
    [[ -L $command_link && $(readlink -- "$command_link") == "$wrapper" ]] || die command 'PREFIX/bin/pi-termux 已存在且不属于此安装目录；未覆盖。可用 --no-link 安装。'
  else
    ln -s -- "$wrapper" "$command_link"
  fi
fi
say "安装完成：termux-pi $APP_VERSION / Pi $PI_VERSION"
say "安装目录：$root"
if ((newly_installed && !skip_configure)) && [[ -t 0 && -t 1 ]]; then
  TERMUX_PI_HOME="$root" "$prefix_real/bin/node" "$root/current/app/cli.mjs" configure
else
  printf '下一步运行：%q configure\n' "$wrapper"
fi
