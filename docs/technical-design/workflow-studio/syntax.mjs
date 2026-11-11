const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

const rules={
  javascript:[['comment',/\/\*[\s\S]*?\*\/|\/\/[^\n]*/],['string',/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],['keyword',/\b(?:async|await|break|case|catch|class|const|continue|default|delete|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|while|yield)\b/],['number',/\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/]],
  python:[['comment',/#[^\n]*/],['string',/(?:[rRuUbBfF]{0,2})?(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/],['keyword',/\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/],['number',/\b\d+(?:\.\d+)?\b/]],
  json:[['property',/"(?:\\.|[^"\\])*"(?=\s*:)/],['string',/"(?:\\.|[^"\\])*"/],['keyword',/\b(?:false|null|true)\b/],['number',/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/]],
  yaml:[['comment',/#[^\n]*/],['property',/^[ \t-]*[A-Za-z_][\w.-]*(?=\s*:)/],['string',/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/],['keyword',/\b(?:FALSE|False|NO|NULL|No|Null|TRUE|True|YES|Yes|false|no|null|true|yes)\b/],['number',/\b\d+(?:\.\d+)?\b/]],
  markdown:[['comment',/<!--[\s\S]*?-->/],['heading',/^#{1,6}(?:[ \t]+|$)[^\n]*/],['property',/\[[^\]\n]+\]\([^\)\n]+\)/],['string',/`[^`\n]+`/],['keyword',/\*\*[^*\n]+\*\*|__[^_\n]+__/]]
};

export function highlightSource(value,language){
  const languageRules=rules[language];
  if(!languageRules)return esc(value)+(value.endsWith('\n')?' ':'');
  const pattern=new RegExp(languageRules.map(([,rule],index)=>`(?<t${index}>${rule.source})`).join('|'),'gm');
  let html='',last=0;
  for(const match of value.matchAll(pattern)){
    html+=esc(value.slice(last,match.index));
    const index=languageRules.findIndex((_,candidate)=>match.groups['t'+candidate]!==undefined);
    html+=`<span class="syntax-${languageRules[index][0]}">${esc(match[0])}</span>`;
    last=match.index+match[0].length;
  }
  return html+esc(value.slice(last))+(value.endsWith('\n')?' ':'');
}
