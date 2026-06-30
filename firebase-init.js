// ===================================================================
// FIREBASE INIT — Run & Rate (Firestore 백엔드)
// 개인 사용 전용. 데이터 구조: projects/{projectId} 문서 + 서브컬렉션
//   projects/{projectId}                  : 프로젝트 메타 (pn, pname, targetUph...)
//   projects/{projectId}/processes/{id}   : 공정 (seq, name, eq, targetCt)
//   projects/{projectId}/cycles/{id}      : 사이클타임 측정 (processId, ts, ct)
//   projects/{projectId}/defects/{id}     : 불량 기록 (processId, ts, type, qty, total)
//   projects/{projectId}/cpkData/{processId} : 공정별 CPK 규격+측정값 (문서 1개=공정 1개)
// ===================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, orderBy,
  serverTimestamp, writeBatch,
  arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDxNj-8aS9Ql0oS579eJSN3thTbIski7HE",
  authDomain: "run-rate-cc593.firebaseapp.com",
  projectId: "run-rate-cc593",
  storageBucket: "run-rate-cc593.firebasestorage.app",
  messagingSenderId: "741523354512",
  appId: "1:741523354512:web:da5d24b37f48ec36267915",
  measurementId: "G-9D5JT5H8KL"
};

const app = initializeApp(firebaseConfig);
// 오프라인 캐시 활성화 (멀티탭 동기화 지원): 인터넷 끊겨도 측정 계속 가능, 재연결시 자동 동기화
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// app.js(non-module 패턴 유지)에서 쓸 수 있도록 전역에 노출
window.__firebase = {
  db,
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc, getDoc,
  getDocsCompat: getDocs,
  onSnapshot, query, orderBy,
  serverTimestamp, writeBatch,
  arrayUnion, arrayRemove
};

// app.js가 이 신호를 기다렸다가 초기화를 시작함
window.dispatchEvent(new Event('firebase-ready'));
