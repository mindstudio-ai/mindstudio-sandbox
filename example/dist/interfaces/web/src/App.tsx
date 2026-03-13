import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import styled from 'styled-components';
import { motion, AnimatePresence } from 'framer-motion';
import api from './api';
import type { Haiku } from '../../methods/src/tables/haikus';

type Mode = 'browse' | 'compose' | 'streaming';

const sans = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

//////////////////////////////////////////////////////////////////////////////
// useFitLongestLine — find the largest font size so the longest line
// across ALL haikus fits without wrapping
//////////////////////////////////////////////////////////////////////////////

function useFitLongestLine(
  haikus: Haiku[],
  boundsRef: React.RefObject<HTMLDivElement | null>,
): string | undefined {
  const [size, setSize] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // Find the single longest line across all haikus
  const longestLine = useMemo(() => {
    let longest = '';
    for (const h of haikus) {
      for (const line of h.text.split('\n')) {
        if (line.length > longest.length) longest = line;
      }
    }
    return longest;
  }, [haikus]);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const bounds = boundsRef.current;
    if (!bounds || !longestLine) { setSize(undefined); return; }

    // Available width = bounds minus horizontal padding (10cqi each side,
    // but we measure the actual inner content width)
    const style = getComputedStyle(bounds);
    const availW = bounds.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (availW <= 0) { setSize(undefined); return; }

    const el = document.createElement('span');
    el.style.cssText = `
      position: absolute; top: -9999px; left: -9999px;
      visibility: hidden; white-space: nowrap;
      font-family: "Cormorant", Georgia, serif;
      font-weight: 300; font-style: italic;
      letter-spacing: 0.015em;
    `;
    el.textContent = longestLine;
    document.body.appendChild(el);

    // Binary search for max font size
    let lo = 16;
    let hi = 200;
    let best = 16;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      el.style.fontSize = `${mid}px`;
      if (el.scrollWidth <= availW) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    document.body.removeChild(el);
    setSize(`${best}px`);
  }, [longestLine, boundsRef, tick]);

  return size;
}

//////////////////////////////////////////////////////////////////////////////
// Animated text — splits into lines, then words, staggering each in
//////////////////////////////////////////////////////////////////////////////

const LineWrap = styled(motion.div)`
  overflow: hidden;
`;

const Word = styled(motion.span)`
  display: inline-block;
  margin-right: 0.25em;

  &:last-child {
    margin-right: 0;
  }
`;

const lineContainerVariants = {
  hidden: {},
  visible: (lineIndex: number) => ({
    transition: {
      staggerChildren: 0.06,
      delayChildren: lineIndex * 0.15,
    },
  }),
};

const wordVariants = {
  hidden: { opacity: 0, y: '100%' },
  visible: {
    opacity: 1,
    y: '0%',
    transition: { duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  },
};

function AnimatedPoem({ text, fontSize }: { text: string; fontSize?: string }) {
  const lines = text.split('\n');
  return (
    <StyledPoem $size={fontSize} aria-label={text} role="img">
      {lines.map((line, li) => (
        <LineWrap
          key={li}
          custom={li}
          variants={lineContainerVariants}
          initial="hidden"
          animate="visible"
        >
          {line.split(/\s+/).filter(Boolean).map((word, wi) => (
            <Word key={wi} variants={wordVariants}>
              {word}
            </Word>
          ))}
          {line.trim() === '' && <span>&nbsp;</span>}
        </LineWrap>
      ))}
    </StyledPoem>
  );
}

//////////////////////////////////////////////////////////////////////////////
// Layout
//////////////////////////////////////////////////////////////////////////////

const Shell = styled.div`
  width: 100%;
  height: 100vh;
  height: 100dvh;
  position: relative;
  overflow: hidden;
`;

const Screen = styled(motion.div)`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`;

//////////////////////////////////////////////////////////////////////////////
// Browse
//////////////////////////////////////////////////////////////////////////////

const BrowseScreen = styled(Screen)`
  user-select: none;
`;

const PoemBounds = styled.div`
  flex: 1;
  width: 100%;
  position: relative;
  container-type: size;
  padding: 0 10cqi;
`;

const PoemSlide = styled(motion.div)`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 32px 10cqi;
`;

const poemBase = `
  font-family: "Cormorant", Georgia, serif;
  font-weight: 300;
  font-style: italic;
  line-height: 1.45;
  letter-spacing: 0.015em;
  color: #000;
`;

const poemFallbackSize = 'min(7cqi, 14cqb)';

const StyledPoem = styled.div<{ $size?: string }>`
  ${poemBase}
  font-size: ${(p) => p.$size || poemFallbackSize};
`;

const PoemFooter = styled(motion.div)`
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: min(24px, 3cqb);
`;

const Meta = styled.span`
  font-family: ${sans};
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: rgba(0, 0, 0, 0.4);
`;

const MetaDot = styled.span`
  color: rgba(0, 0, 0, 0.2);
  font-size: 8px;
`;

const RemoveBtn = styled.button`
  font-family: ${sans};
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: rgba(0, 0, 0, 0.35);
  transition: color 0.2s;
  &:hover { color: rgba(0, 0, 0, 0.7); }
`;

const Nav = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 28px;
  height: 72px;
  flex-shrink: 0;
`;

const NavArrow = styled.button`
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  & svg { stroke: rgba(0,0,0,0.25); transition: stroke 0.2s; }
  &:hover svg { stroke: rgba(0,0,0,0.5); }
`;

const NavLabel = styled.span`
  font-family: ${sans};
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: rgba(0, 0, 0, 0.35);
  min-width: 48px;
  text-align: center;
`;

const Fab = styled(motion.button)`
  position: absolute;
  bottom: 28px;
  right: 32px;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  & svg { stroke: #fff; }
  &:hover { background: #1a1a1a; }
`;

const EmptyCenter = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`;

const EmptyText = styled.p`
  font-family: "Cormorant", Georgia, serif;
  font-size: 20px;
  font-weight: 300;
  font-style: italic;
  color: rgba(0, 0, 0, 0.18);
  margin: 0 0 12px;
`;

const EmptyHint = styled.p`
  font-family: ${sans};
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: rgba(0, 0, 0, 0.3);
  margin: 0;
`;

//////////////////////////////////////////////////////////////////////////////
// Compose
//////////////////////////////////////////////////////////////////////////////

const ComposeScreen = styled(Screen)`
  padding: 0 40px;
`;

const ComposeInner = styled.div`
  max-width: 520px;
  width: 100%;
  text-align: center;
`;

const ComposeLabel = styled.div`
  font-family: ${sans};
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(0, 0, 0, 0.35);
  margin-bottom: 56px;
`;

const TopicInput = styled.input`
  display: block;
  width: 100%;
  padding: 16px 0;
  font-family: "Cormorant", Georgia, serif;
  font-size: clamp(24px, 5vw, 36px);
  font-weight: 300;
  font-style: italic;
  color: #000;
  text-align: center;
  letter-spacing: 0.02em;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08) !important;
  transition: border-color 0.3s;
  &::placeholder { color: rgba(0, 0, 0, 0.15); }
  &:focus { border-bottom-color: rgba(0, 0, 0, 0.25) !important; }
`;

const ComposeActions = styled.div`
  margin-top: 48px;
  display: flex;
  justify-content: center;
  gap: 48px;
`;

const TextBtn = styled.button<{ $strong?: boolean }>`
  font-family: ${sans};
  font-size: 13px;
  font-weight: ${(p) => (p.$strong ? 500 : 400)};
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${(p) => (p.$strong ? '#000' : 'rgba(0, 0, 0, 0.35)')};
  transition: color 0.2s;
  &:hover { color: #000; }
`;

//////////////////////////////////////////////////////////////////////////////
// Streaming
//////////////////////////////////////////////////////////////////////////////

const StreamScreen = styled(Screen)`
  container-type: size;
`;

const StreamInner = styled(motion.div)<{ $size?: string }>`
  padding: 32px 10cqi;
  width: 100%;
  ${poemBase}
  font-size: ${(p) => p.$size || poemFallbackSize};
  color: rgba(0, 0, 0, 0.3);
`;

const StreamHint = styled(motion.div)`
  position: absolute;
  bottom: 40px;
  font-family: ${sans};
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: rgba(0, 0, 0, 0.3);
`;

//////////////////////////////////////////////////////////////////////////////
// Icons
//////////////////////////////////////////////////////////////////////////////

const Plus = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" strokeWidth="1.5" strokeLinecap="round">
    <line x1="10" y1="4" x2="10" y2="16" />
    <line x1="4" y1="10" x2="16" y2="10" />
  </svg>
);

const LeftChevron = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="11,4 6,9 11,14" />
  </svg>
);

const RightChevron = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="7,4 12,9 7,14" />
  </svg>
);

//////////////////////////////////////////////////////////////////////////////
// Helpers & animation config
//////////////////////////////////////////////////////////////////////////////

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

const pageFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.3, ease: 'easeInOut' as const },
};

const footerFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { delay: 0.4, duration: 0.4 },
};

//////////////////////////////////////////////////////////////////////////////
// App
//////////////////////////////////////////////////////////////////////////////

export default function App() {
  const [mode, setMode] = useState<Mode>('browse');
  const [topic, setTopic] = useState('');
  const [haikus, setHaikus] = useState<Haiku[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [idx, setIdx] = useState(0);
  const [stream, setStream] = useState('');

  const current = haikus[idx];
  const poemBoundsRef = useRef<HTMLDivElement>(null);
  const fittedSize = useFitLongestLine(haikus, poemBoundsRef);

  const fetchHaikus = useCallback(async () => {
    const result = await api.listHaikus();
    setHaikus(result.haikus);
    setLoaded(true);
  }, []);

  useEffect(() => { fetchHaikus(); }, [fetchHaikus]);

  const goNext = useCallback(() => {
    setIdx((i) => (i + 1) % haikus.length);
  }, [haikus.length]);

  const goPrev = useCallback(() => {
    setIdx((i) => (i - 1 + haikus.length) % haikus.length);
  }, [haikus.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== 'browse' || haikus.length < 2) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goNext();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const generate = async () => {
    const t = topic.trim();
    if (!t) return;
    setMode('streaming');
    setStream('');
    try {
      const result = await api.generateHaiku(
        { topic: t },
        {
          stream: true,
          onToken: (text: string) => {
            console.log('[stream chunk]', JSON.stringify(text));
            setStream(text);
          },
        },
      );
      console.log('[stream done]', result);
      setHaikus((prev) => [result as unknown as Haiku, ...prev]);
      setIdx(0);
      setMode('browse');
    } catch {
      setMode('compose');
    }
  };

  const remove = async (id: string) => {
    await api.deleteHaiku({ id });
    setHaikus((prev) => {
      const next = prev.filter((h) => h.id !== id);
      if (idx >= next.length && next.length > 0) setIdx(next.length - 1);
      return next;
    });
  };

  return (
    <Shell>
      <AnimatePresence mode="wait">

        {mode === 'browse' && (
          <BrowseScreen key="browse" {...pageFade}>
            <PoemBounds ref={poemBoundsRef}>
              {loaded && haikus.length === 0 && (
                <EmptyCenter>
                  <EmptyText>no haikus yet</EmptyText>
                  <EmptyHint>tap + to write one</EmptyHint>
                </EmptyCenter>
              )}
              <AnimatePresence mode="wait">
                {current && (
                  <PoemSlide
                    key={current.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <AnimatedPoem text={current.text} fontSize={fittedSize} />
                    <PoemFooter {...footerFade}>
                      <Meta>{formatDate(current.created_at)}</Meta>
                      <MetaDot>&middot;</MetaDot>
                      <RemoveBtn onClick={() => remove(current.id)}>Remove</RemoveBtn>
                    </PoemFooter>
                  </PoemSlide>
                )}
              </AnimatePresence>
            </PoemBounds>

            {haikus.length > 1 && (
              <Nav>
                <NavArrow onClick={goPrev}>
                  <LeftChevron />
                </NavArrow>
                <NavLabel>{idx + 1} / {haikus.length}</NavLabel>
                <NavArrow onClick={goNext}>
                  <RightChevron />
                </NavArrow>
              </Nav>
            )}

            <Fab onClick={() => { setTopic(''); setMode('compose'); }} whileTap={{ scale: 0.9 }}>
              <Plus />
            </Fab>
          </BrowseScreen>
        )}

        {mode === 'compose' && (
          <ComposeScreen key="compose" {...pageFade}>
            <ComposeInner>
              <ComposeLabel>New haiku</ComposeLabel>
              <TopicInput
                placeholder="a topic..."
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generate()}
                autoFocus
              />
              <ComposeActions>
                <TextBtn onClick={() => setMode('browse')}>Cancel</TextBtn>
                <TextBtn $strong onClick={generate}>Generate</TextBtn>
              </ComposeActions>
            </ComposeInner>
          </ComposeScreen>
        )}

        {mode === 'streaming' && (
          <StreamScreen key="streaming" {...pageFade}>
            <StreamInner
              $size={fittedSize}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5 }}
            >
              {stream || '\u00A0'}
            </StreamInner>
            <StreamHint
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              writing...
            </StreamHint>
          </StreamScreen>
        )}

      </AnimatePresence>
    </Shell>
  );
}
