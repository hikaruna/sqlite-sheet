// 正規表現の SQL 関数。関数名と引数の順は sqlean-regexp に合わせる。
// パターンは JavaScript の RegExp（u フラグ付き）として解釈する。引数に NULL があれば結果も NULL

const cache = new Map(); // 同じパターンを行ごとにコンパイルし直さないように

function re(pattern, flags) {
  const key = `${flags}/${pattern}`;
  let r = cache.get(key);
  if (!r) {
    if (cache.size >= 100) cache.clear();
    r = new RegExp(pattern, flags);
    cache.set(key, r);
  }
  return r;
}

const find = (text, pattern) => re(pattern, 'u').exec(String(text));

// 名前: [引数の個数（の候補）, 関数]
const FUNCTIONS = {
  // text REGEXP pattern は regexp(pattern, text) の呼び出しになる
  regexp: [2, (pattern, text) => Number(re(pattern, 'u').test(String(text)))],
  regexp_like: [2, (text, pattern) => Number(re(pattern, 'u').test(String(text)))],
  regexp_substr: [2, (text, pattern) => find(text, pattern)?.[0] ?? null],
  regexp_capture: [[2, 3], (text, pattern, n = 0) => find(text, pattern)?.[n] ?? null],
  regexp_replace: [3, (text, pattern, replacement) => String(text).replace(re(pattern, 'gu'), replacement)],
};

/** DB の接続に正規表現の関数を登録する（接続ごとに必要。DB ファイルには残らない） */
export function addRegexpFunctions(db) {
  for (const [name, [arities, fn]] of Object.entries(FUNCTIONS)) {
    for (const arity of [arities].flat()) {
      db.createFunction(name, {
        arity,
        deterministic: true,
        xFunc: (_ctx, ...args) => (args.includes(null) || args.includes(undefined) ? null : fn(...args)),
      });
    }
  }
}
