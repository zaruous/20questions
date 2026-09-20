import React from 'react';

/** 이름으로 색을 정한다. 서버를 거치지 않아도 모든 사람의 화면에서 같은 사람이 같은 색으로 보인다. */
export function hueOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** 이름 첫 글자 아바타. 스타일은 styles.css의 .avatar */
export default function Avatar({ name, size }) {
  return (
    <span className={`avatar${size ? ` avatar--${size}` : ''}`} style={{ '--h': hueOf(name) }} aria-hidden="true">
      {[...name][0]}
    </span>
  );
}
