/**
 * screens.tsx
 *
 * The disclosure ladder shows up here as a TYPE, not a conditional. GameDetail
 * receives a `Game`, narrows it with isMember(), and in the `public` branch the
 * venue is not merely hidden — it does not exist to be rendered. Delete the
 * guard and the code stops compiling.
 */
import React, { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, TextInput, Alert, ActivityIndicator } from "react-native";
import {
  isMember, type Game, type PublicGame, type Sport, type SportId,
  type Person, type SportDemand, type Repo, type Venue, type WeeklyPrompt,
  type SportRequest,
  myShare, formatMoney, reliability, sortForFeed, whereText,
  hiddenUntilYoureIn, primaryAction, splitSides, isValidPlayerCount,
  hostIsOutOfPocket, bestAreaFor,
} from "@hangout/shared";
import {
  Screen, Body, Nav, Button, Card, Block, Label, Row, P, Note, Tag, Pip,
  Meter, Chip, Tabs, useTheme, styles,
} from "./ui";

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((d.getTime() - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const dow = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
  const time = d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" }).replace(" ", "");
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  return `${dow} · ${time}`;
};

/* ══════════════════════════════════════════════════════ Welcome */

export function Welcome({ onCreate, onSignIn }: { onCreate: () => void; onSignIn: () => void }) {
  const t = useTheme();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 28, gap: 14 }}>
        <Text style={{ fontSize: 44, fontWeight: "900", letterSpacing: -2, color: t.ink }}>
          hang<Text style={{ color: t.accent }}>out</Text>
        </Text>
        <P style={{ textAlign: "center", maxWidth: 260 }}>
          Somebody near you is one player short. Find them.
        </P>
        <View style={{ height: 18 }} />
        <Button label="Create an account" onPress={onCreate} style={{ width: 260 }} />
        <Button label="I've already got one" kind="ghost" onPress={onSignIn} style={{ width: 260 }} />
        <Note>Leicester · 2 sports live, 6 waiting to open</Note>
      </View>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ Onboarding */

export function PickSports({ sports, demand, onDone }: {
  sports: Sport[]; demand: SportDemand[];
  onDone: (name: string, picked: SportId[]) => void;
}) {
  const t = useTheme();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<SportId[]>([]);
  const toggle = (id: SportId) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const live = sports.filter((s) => s.globallyLive);
  const soon = sports.filter((s) => !s.globallyLive);
  const want = (id: SportId) => demand.find((d) => d.sportId === id && d.areaId === "LE18");

  const Tile = ({ s }: { s: Sport }) => {
    const on = picked.includes(s.id);
    const d = want(s.id);
    return (
      <Pressable onPress={() => toggle(s.id)} style={{
        flexDirection: "row", alignItems: "center", gap: 13, padding: 14,
        borderWidth: 1.5, borderRadius: 16,
        borderColor: on ? t.ink : t.line,
        backgroundColor: on ? t.card2 : t.card,
        borderStyle: s.globallyLive ? "solid" : "dashed",
      }}>
        <Text style={{ fontSize: 25 }}>{s.emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15.5, fontWeight: "700", color: t.ink }}>{s.name}</Text>
          <Text style={{ fontSize: 12, color: t.ink2 }}>
            {s.globallyLive
              ? "Live near you"
              : `${d?.wantCount ?? 0} of ${s.launchThreshold} people needed near you`}
          </Text>
          {!s.globallyLive && d && (
            <View style={{ marginTop: 6 }}>
              <Meter value={d.wantCount} max={s.launchThreshold}
                     tone={d.wantCount / s.launchThreshold > 0.8 ? "close" : undefined} />
            </View>
          )}
        </View>
        <View style={{
          width: 22, height: 22, borderRadius: 11, borderWidth: 1.5,
          borderColor: on ? t.ink : t.line, backgroundColor: on ? t.ink : "transparent",
          alignItems: "center", justifyContent: "center",
        }}>
          {on && <Text style={{ color: t.paper, fontSize: 12 }}>✓</Text>}
        </View>
      </Pressable>
    );
  };

  return (
    <Screen>
      <Nav title="What do you play?" sub="Pick everything you'd turn up for" />
      <Body>
        <View style={{ gap: 5 }}>
          <Label>Your name</Label>
          <TextInput
            value={name} onChangeText={setName} placeholder="Shiv" placeholderTextColor={t.ink3}
            style={{
              borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 13,
              fontSize: 16, color: t.ink, backgroundColor: t.card,
            }}
          />
        </View>

        <Label>Live near you</Label>
        {live.map((s) => <Tile key={s.id} s={s} />)}

        <Label>Not open here yet</Label>
        <Note>
          A sport switches on when enough people nearby want it. Pick them anyway — you get counted,
          and told the moment it opens.
        </Note>
        {soon.map((s) => <Tile key={s.id} s={s} />)}

        <Button
          label="Find my people"
          disabled={!name.trim() || picked.length === 0}
          onPress={() => onDone(name.trim(), picked)}
        />
      </Body>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ Home */

export function Home({ games, prompts, onOpen, onJoin, onOut, onPost, radiusMiles, area }: {
  games: PublicGame[]; prompts: WeeklyPrompt[];
  onOpen: (id: string) => void; onJoin: (id: string) => void; onOut: (id: string) => void;
  onPost: () => void; radiusMiles: number; area: string;
}) {
  const sorted = sortForFeed(games);
  const asked = new Set(prompts.map((p) => p.gameId));
  const needs = sorted.filter((g) => g.spotsLeft > 0 && !g.iAmIn && !asked.has(g.id));
  const mine = sorted.filter((g) => g.iAmIn);
  const full = sorted.filter((g) => g.spotsLeft === 0 && !g.iAmIn && !asked.has(g.id));

  return (
    <Screen>
      <Nav title="Near you" sub={`Within ${radiusMiles} miles of ${area}`}
           action={{ label: "+ Post", onPress: onPost }} />
      <Body>
        {games.length === 0 && prompts.length === 0 && (
          <Block>
            <Text style={{ fontSize: 18, fontWeight: "800" }}>No games yet</Text>
            <P>You're early. Post the first one — everyone nearby who plays what you play will hear about it.</P>
            <Button label="Post the first game" onPress={onPost} />
          </Block>
        )}

        {/*
          THE STANDING FIXTURE, at the top, above everything.
          Most real amateur sport is a fixture, not an event — "the Friday
          badminton" — and the only question anyone ever asks is "are you in
          this week?". That is the question WhatsApp is genuinely bad at: it
          scrolls away, half the group never answers, and the host counts heads
          by reading back through forty messages of banter.
        */}
        {prompts.length > 0 && <Label>This week</Label>}
        {prompts.map((p) => <WeeklyCard key={p.gameId} p={p} onIn={onJoin} onOut={onOut} onOpen={onOpen} />)}

        {needs.length > 0 && <Label>Needs a player</Label>}
        {needs.map((g) => <GameCard key={g.id} g={g} onOpen={onOpen} onJoin={onJoin} />)}
        {mine.length > 0 && <Label>You're playing</Label>}
        {mine.map((g) => <GameCard key={g.id} g={g} onOpen={onOpen} onJoin={onJoin} />)}
        {full.length > 0 && <Label>Full</Label>}
        {full.map((g) => <GameCard key={g.id} g={g} onOpen={onOpen} onJoin={onJoin} />)}
      </Body>
    </Screen>
  );
}

/**
 * "Are you in this week?"
 *
 * Two buttons, both of them an answer. There is no way to dismiss this without
 * answering it, and that is the entire design: SILENCE IS NOT A YES. An
 * unanswered regular is a question, never an attendance — treat it as a yes and
 * the host turns up to a booked court expecting six and finds two.
 */
function WeeklyCard({ p, onIn, onOut, onOpen }: {
  p: WeeklyPrompt; onIn: (id: string) => void; onOut: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const t = useTheme();
  return (
    <Card tone="ask">
      <View style={styles.row}>
        <Text style={{
          fontSize: 10, fontWeight: "800", letterSpacing: 0.7,
          textTransform: "uppercase", color: t.amber, flex: 1,
        }}>
          Your regular · are you in?
        </Text>
        <Text style={{ fontSize: 11.5, fontWeight: "700", color: t.ink3 }}>{when(p.startsAt)}</Text>
      </View>

      <Pressable onPress={() => onOpen(p.gameId)}>
        <Text style={{ fontSize: 16.5, fontWeight: "800", color: t.ink, letterSpacing: -0.3 }}>
          {p.title}
        </Text>
        <Text style={{ fontSize: 12.5, color: t.ink2, marginTop: 3 }}>
          {p.distanceMiles} miles away · {p.areaName}
          {"  ·  "}{p.playerCount} in so far
          {p.spotsLeft > 0 ? `, ${p.spotsLeft} spot${p.spotsLeft === 1 ? "" : "s"} left` : ", full"}
        </Text>
      </Pressable>

      <Text style={{ fontSize: 11.5, color: t.ink3 }}>
        {p.answered} of {p.regulars} regulars have answered
      </Text>

      <View style={[styles.row, { gap: 7 }]}>
        <Button testID="weekly-in" small label="I'm in"
                onPress={() => onIn(p.gameId)} style={{ flex: 1 }} />
        <Button testID="weekly-out" small kind="ghost" label="Can't make it"
                onPress={() => onOut(p.gameId)} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

function GameCard({ g, onOpen, onJoin }: {
  g: PublicGame; onOpen: (id: string) => void; onJoin: (id: string) => void;
}) {
  const t = useTheme();
  const action = primaryAction(g);
  const tone = g.spotsLeft > 0 ? "urgent" : "filled";

  // The roster is anonymous until you are in it. These grey circles ARE the
  // privacy model, made visible.
  const pips = Array.from({ length: Math.min(g.playerCount, 3) }, (_, i) => (
    <Pip key={i} i={i} anon={!g.iAmIn} initials="•"
         ring={g.spotsLeft > 0 ? t.accentWash : t.courtWash} />
  ));

  return (
    <Card tone={tone} onPress={() => onOpen(g.id)}>
      <View style={styles.row}>
        <Text style={{
          fontSize: 10, fontWeight: "800", letterSpacing: 0.7, textTransform: "uppercase",
          color: g.spotsLeft > 0 ? t.accent : t.court, flex: 1,
        }}>
          {g.spotsLeft > 0
            ? `${g.spotsLeft} spot${g.spotsLeft === 1 ? "" : "s"} left`
            : g.iAmIn ? "Full · you're playing" : "Full"}
        </Text>
        <Text style={{ fontSize: 11.5, fontWeight: "700", color: t.ink3 }}>{when(g.startsAt)}</Text>
      </View>

      <Text style={{ fontSize: 16.5, fontWeight: "800", color: t.ink, letterSpacing: -0.3 }}>
        {g.title}
      </Text>

      {/* coarse location only. "1.2 miles away · Wigston" — never the building. */}
      <Text style={{ fontSize: 12.5, color: t.ink2 }}>
        {whereText(g)}
        {"  ·  "}{g.costPence > 0 ? `${formatMoney(myShare(g))} each` : "Free"}
        {g.approveRequired && !g.iAmIn ? "  ·  Host approves" : ""}
      </Text>

      <View style={[styles.row, { gap: 8 }]}>
        <View style={styles.row}>
          {pips}
          {g.spotsLeft > 0 && <Pip i={pips.length} empty />}
        </View>
        <Text style={{
          fontSize: 12.5, fontWeight: "800", marginLeft: 5,
          color: g.spotsLeft > 0 ? t.accent : t.court,
        }}>
          {g.playerCount}/{g.spotsNeeded}
        </Text>
        <View style={{ flex: 1 }} />
        {action === "in" && <Button small label="I'm in" onPress={() => onJoin(g.id)} />}
        {action === "ask" && <Button small kind="dark" label="Ask to join" onPress={() => onJoin(g.id)} />}
        {action === "waitlist" && <Button small kind="ghost" label="Waitlist" onPress={() => onJoin(g.id)} />}
        {action === "waiting" && <Button small kind="ghost" label="Waiting" onPress={() => onOpen(g.id)} />}
        {action === "open" && <Button small kind="ghost" label="Open" onPress={() => onOpen(g.id)} />}
      </View>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════ Game detail */

export function GameDetail({ game, sport, onBack, onJoin, onLeave, onAccept, onSend }: {
  game: Game; sport: Sport | undefined; onBack: () => void;
  onJoin: () => void; onLeave: () => void;
  onAccept: (profileId: string) => void; onSend: (body: string) => void;
}) {
  const t = useTheme();
  const [msg, setMsg] = useState("");
  const action = primaryAction(game);
  const hidden = hiddenUntilYoureIn(game);
  const hostRep = reliability({ gamesAttended: game.hostAttended, gamesMissed: game.hostMissed });

  return (
    <Screen>
      <Nav title={`${sport?.emoji ?? ""} ${game.title}`} sub={when(game.startsAt)} onBack={onBack} />
      <Body>
        <Block title={`${sport?.name ?? ""}${game.repeatsWeekly ? " · repeats weekly" : ""}`}>
          {/*
            THE LADDER. In the `public` branch there is no venue to render —
            not hidden, absent. Remove the isMember() guard below and this file
            stops compiling, because PublicGame has no `venueName`.
          */}
          <Row
            left={<Text style={{ fontSize: 14, fontWeight: "600", color: t.ink }}>{whereText(game)}</Text>}
            right={<Text style={{ fontSize: 15 }}>{isMember(game) ? "" : "🔒"}</Text>}
          />
          <View style={[styles.chips]}>
            {game.beginnersWelcome && <Tag tone="new">Beginners welcome</Tag>}
            {!!game.minLevel && <Tag>{game.minLevel} and up</Tag>}
            <Tag>{game.durationMin} min</Tag>
            <Tag tone={hostRep.concerning ? "warn" : "good"}>Host: {hostRep.text}</Tag>
          </View>
          {!!game.note && <P style={{ fontSize: 13 }}>{game.note}</P>}
        </Block>

        {/* Say plainly what is held back. A locked door with no sign is just a wall. */}
        {!isMember(game) && (
          <View style={{
            borderWidth: 1, borderColor: t.line, borderStyle: "dashed",
            borderRadius: 14, padding: 14, gap: 8, backgroundColor: t.card,
          }}>
            <Label>🔒 Shown once you're in</Label>
            {hidden.map((h) => (
              <Row key={h}
                left={<Text style={{ fontSize: 13.5, color: t.ink }}>{h}</Text>}
                right={<Text style={{ fontSize: 13, fontWeight: "700", color: t.ink3 }}>Hidden</Text>} />
            ))}
            <Note>
              You can see how far it is and roughly where, so you can decide. We don't put people's
              names next to a place and a time for strangers to read — that's the bit that matters.
              {game.approveRequired ? " The host approves who joins this one." : ""}
            </Note>
          </View>
        )}

        <Block title={`Playing · ${game.playerCount} of ${game.spotsNeeded}`}>
          <View style={styles.row}>
            {Array.from({ length: game.playerCount }, (_, i) => (
              <Pip key={i} i={i} anon={!isMember(game)}
                   initials={isMember(game) ? game.players[i]?.initials : undefined} />
            ))}
            {game.spotsLeft > 0 && <Pip i={game.playerCount} empty />}
          </View>

          {isMember(game)
            ? game.players.map((p) => {
                const r = reliability(p);
                return (
                  <Row key={p.profileId}
                    left={
                      <Text style={{ fontSize: 13.5, color: t.ink }}>
                        {p.displayName}{p.isHost ? " · host" : ""}
                      </Text>
                    }
                    right={
                      <View style={[styles.row, { gap: 6 }]}>
                        {!!p.level && <Tag>{p.level}</Tag>}
                        <Tag tone={r.concerning ? "warn" : "good"}>{r.text}</Tag>
                      </View>
                    } />
                );
              })
            : <Note>
                {game.playerCount} {game.playerCount === 1 ? "person" : "people"} playing.
                You'll see who they are once you're in.
              </Note>}
        </Block>

        {/* Sides balance at ANY count. Uneven is fine — uneven is normal. */}
        {isMember(game) && game.splitTeams && game.players.length > 1 && (() => {
          const { a, b } = splitSides(game.players);
          return (
            <Block title={`Sides · aiming for ${Math.floor(game.spotsNeeded / 2)} a side`}>
              <Row left={<Text style={{ color: t.ink2, fontSize: 13 }}>Bibs</Text>}
                   right={<Text style={{ color: t.ink, fontWeight: "700", fontSize: 13 }}>
                     {a.map((p) => p.displayName).join(", ") || "—"}</Text>} />
              <Row left={<Text style={{ color: t.ink2, fontSize: 13 }}>Non-bibs</Text>}
                   right={<Text style={{ color: t.ink, fontWeight: "700", fontSize: 13 }}>
                     {b.map((p) => p.displayName).join(", ") || "—"}</Text>} />
              <Note>Sides rebalance as people join and drop out. Uneven is fine — it usually is.</Note>
            </Block>
          );
        })()}

        {/* The host is the one out of pocket. That is the real pain, so name it. */}
        {game.costPence > 0 && (
          <Block title="Cost">
            <Row left={<Text style={{ color: t.ink2, fontSize: 13.5 }}>Court hire</Text>}
                 right={<Text style={{ fontWeight: "700", color: t.ink }}>{formatMoney(game.costPence)}</Text>} />
            <Row left={<Text style={{ color: t.ink2, fontSize: 13.5 }}>
                   Split {game.playerCount} way{game.playerCount === 1 ? "" : "s"}</Text>}
                 right={<Text style={{ fontWeight: "700", color: t.ink }}>{formatMoney(myShare(game))} each</Text>} />
            {isMember(game) && (() => {
              const owed = hostIsOutOfPocket(game.players, game.costPence);
              return owed > 0 ? (
                <Row left={<Text style={{ color: t.ink2, fontSize: 13.5 }}>{game.hostName} is out of pocket</Text>}
                     right={<Text style={{ fontWeight: "800", color: t.amber }}>{formatMoney(owed)}</Text>} />
              ) : null;
            })()}
            {!isMember(game) && (
              <Note>We never hold your money. The host pays the venue; everyone pays the host back.</Note>
            )}
          </Block>
        )}

        {/* The host decides who joins. Never the admin. */}
        {isMember(game) && game.iAmHost && game.asks.length > 0 && (
          <Block title={`Asking to join · ${game.asks.length}`}>
            {game.asks.map((a) => {
              const r = reliability(a);
              return (
                <Row key={a.profileId}
                  left={<Text style={{ fontSize: 13.5, color: t.ink }}>{a.displayName}</Text>}
                  right={
                    <View style={[styles.row, { gap: 8 }]}>
                      <Tag tone={r.concerning ? "warn" : "good"}>{r.text}</Tag>
                      <Button small kind="green" label="Let in" onPress={() => onAccept(a.profileId)} />
                    </View>
                  } />
              );
            })}
            <Note>You decide, not us. They see the venue and the group the moment you let them in.</Note>
          </Block>
        )}

        {isMember(game) && (
          <Block title={`Chat · ${game.messages.length}`}>
            {game.messages.slice(-6).map((m) => (
              <Text key={m.id} style={{ fontSize: 13, color: m.profileId ? t.ink : t.ink3 }}>
                {m.profileId ? <Text style={{ fontWeight: "700" }}>{m.authorName}: </Text> : null}
                {m.body}
              </Text>
            ))}
            <View style={[styles.row, { gap: 8 }]}>
              <TextInput
                value={msg} onChangeText={setMsg} placeholder="Message the group…"
                placeholderTextColor={t.ink3}
                style={{
                  flex: 1, backgroundColor: t.card2, borderRadius: 999,
                  paddingHorizontal: 14, paddingVertical: 9, fontSize: 15, color: t.ink,
                }}
              />
              <Pressable onPress={() => { if (msg.trim()) { onSend(msg.trim()); setMsg(""); } }}>
                <Text style={{ color: t.accent, fontWeight: "800" }}>Send</Text>
              </Pressable>
            </View>
          </Block>
        )}

        {isMember(game) && !game.iAmHost && (
          <Button kind="flat" label="Leave this game" onPress={onLeave} />
        )}
      </Body>

      <View style={{
        flexDirection: "row", alignItems: "center", gap: 10, padding: 20, paddingTop: 12,
        borderTopWidth: 1, borderTopColor: t.lineSoft, backgroundColor: t.card,
      }}>
        {game.costPence > 0 && (
          <View>
            <Text style={{ fontSize: 11, color: t.ink3, fontWeight: "700" }}>Your share</Text>
            <Text style={{ fontSize: 17, fontWeight: "800", color: t.ink }}>{formatMoney(myShare(game))}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          {action === "open" && <Button kind="green" label="You're in ✓" disabled />}
          {action === "in" && <Button label="I'm in" onPress={onJoin} />}
          {action === "ask" && <Button kind="dark" label="Ask to join" onPress={onJoin} />}
          {action === "waitlist" && <Button kind="dark" label="Join the waitlist" onPress={onJoin} />}
          {action === "waiting" && <Button kind="amber" label="Waiting on the host" disabled />}
        </View>
      </View>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ Sports / demand */

export function Sports({ sports, demand, onWant, onBack }: {
  sports: Sport[]; demand: SportDemand[];
  onWant: (id: SportId) => void; onBack?: () => void;
}) {
  const t = useTheme();
  const here = demand.filter((d) => d.areaId === "LE18");
  const live = here.filter((d) => d.isLive);
  const locked = here.filter((d) => !d.isLive).sort((a, b) => b.wantCount / b.threshold - a.wantCount / a.threshold);
  const sport = (id: SportId) => sports.find((s) => s.id === id)!;

  return (
    <Screen>
      <Nav title="Sports" sub="Near LE18" onBack={onBack} />
      <Body>
        <Label>Live near you</Label>
        {sports.filter((s) => s.globallyLive || live.some((l) => l.sportId === s.id)).map((s) => (
          <Block key={s.id}>
            <Row
              left={<Text style={{ fontSize: 15, fontWeight: "700", color: t.ink }}>{s.emoji} {s.name}</Text>}
              right={<Tag tone="good">Open</Tag>} />
          </Block>
        ))}

        <Label>Waiting to open</Label>
        <Note>
          A sport only switches on when enough people near you want it. Four padel players in ten
          miles isn't a sport, it's an empty court.
        </Note>

        {locked.map((d) => {
          const s = sport(d.sportId);
          return (
            <View key={d.sportId} style={{
              borderWidth: 1, borderStyle: "dashed", borderColor: t.line,
              borderRadius: 16, padding: 13, gap: 9, backgroundColor: t.card,
            }}>
              <View style={[styles.row, { gap: 12 }]}>
                <Text style={{ fontSize: 26, opacity: 0.6 }}>{s.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: t.ink }}>{s.name}</Text>
                  <Text style={{ fontSize: 11.5, color: t.ink2 }}>
                    {d.wantCount} of {d.threshold} people near LE18 · {d.venuesHere} venue
                    {d.venuesHere === 1 ? "" : "s"} ready
                  </Text>
                </View>
                <Button small kind="dark" label="I want this" onPress={() => onWant(d.sportId)} />
              </View>
              <Meter value={d.wantCount} max={d.threshold}
                     tone={d.wantCount / d.threshold > 0.8 ? "close" : undefined} />
              {d.stillNeeded === 1 && (
                <Note tone="amber">One more person and {s.name.toLowerCase()} opens here.</Note>
              )}
            </View>
          );
        })}

        <Note>
          Demand first, then supply. It's also how we know which sport to open next, and exactly where.
        </Note>
      </Body>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ People */

export function People({ people }: { people: Person[] }) {
  const t = useTheme();
  return (
    <Screen>
      <Nav title="People near you" sub={`${people.length} play what you play`} />
      <Body>
        {people.map((p) => {
          const r = reliability(p);
          return (
            <Block key={p.id}>
              <Row
                left={
                  <View>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: t.ink }}>{p.displayName}</Text>
                    {/* A BAND. Never a decimal — three exact distances are an address. */}
                    <Text style={{ fontSize: 12, color: t.ink2 }}>{p.distanceBand}</Text>
                  </View>
                }
                right={
                  <View style={[styles.row, { gap: 6 }]}>
                    {p.isNewToArea && <Tag tone="new">New here</Tag>}
                    <Tag tone={r.concerning ? "warn" : "good"}>{r.text}</Tag>
                  </View>
                } />
            </Block>
          );
        })}
        <Note>
          Distances are bands, never exact — an exact distance read from three places is an address.
          The number by each name is games turned up to.
        </Note>
      </Body>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ Post a game */

export function PostGame({ sports, venues, onPost, onBack, onPickSport, sportId }: {
  sports: Sport[]; venues: Venue[]; sportId: SportId;
  onPickSport: (s: SportId) => void;
  onPost: (input: {
    sportId: SportId; venueId: string; title: string; spotsNeeded: number;
    costPence: number; repeatsWeekly: boolean; approveRequired: boolean; note: string;
  }) => void;
  onBack: () => void;
}) {
  const t = useTheme();
  const sport = sports.find((s) => s.id === sportId)!;
  const [title, setTitle] = useState("");
  const [venueId, setVenueId] = useState(venues[0]?.id ?? "");
  const [spots, setSpots] = useState(String(sport.typicalPlayers));
  const [cost, setCost] = useState(String((venues[0]?.pricePence ?? 0) / 100));
  const [repeats, setRepeats] = useState(false);
  const [approve, setApprove] = useState(false);
  const [note, setNote] = useState("");

  const live = sports.filter((s) => s.globallyLive);
  const venue = venues.find((v) => v.id === venueId);
  const n = parseInt(spots, 10);

  const pickVenue = (v: Venue) => {
    setVenueId(v.id);
    setCost(String(v.pricePence / 100));   // cost follows the venue — and stays editable
  };

  return (
    <Screen>
      <Nav title="Post a game" sub="About twenty seconds" onBack={onBack} />
      <Body>
        <View style={styles.chips}>
          {live.map((s) => (
            <Chip key={s.id} label={`${s.emoji} ${s.name}`} on={s.id === sportId}
                  onPress={() => { onPickSport(s.id); setSpots(String(s.typicalPlayers)); }} />
          ))}
        </View>

        <View style={{ gap: 5 }}>
          <Label>What is it?</Label>
          <TextInput value={title} onChangeText={setTitle} placeholder="Friday doubles"
            placeholderTextColor={t.ink3}
            style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 13, fontSize: 16, color: t.ink }} />
        </View>

        <View style={{ gap: 5 }}>
          <Label>Where</Label>
          <View style={styles.chips}>
            {venues.map((v) => (
              <Chip key={v.id} on={v.id === venueId} onPress={() => pickVenue(v)}
                    label={`${v.name} · ${v.distanceMiles}mi · ${v.pricePence ? `£${v.pricePence / 100}` : "free"}`} />
            ))}
          </View>
        </View>

        {/*
          NOTHING IS FIXED. The presets are shortcuts. The number underneath is
          always editable — badminton is singles, doubles, six rotating, or
          eight across two courts, and a locked field would be my habit
          masquerading as a law.
        */}
        <View style={{ gap: 5 }}>
          <Label>How many players?</Label>
          <View style={styles.chips}>
            {sport.presets.map((p) => (
              <Chip key={p.label} label={`${p.label} · ${p.n}`} on={n === p.n}
                    onPress={() => setSpots(String(p.n))} />
            ))}
          </View>
          <TextInput value={spots} onChangeText={setSpots} keyboardType="number-pad"
            style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 13, fontSize: 16, color: t.ink }} />
          <Note>
            Shortcuts above, or type any number. Nothing is fixed — {sport.name.toLowerCase()} is
            whatever you and the people turning up decide it is.
          </Note>
        </View>

        <View style={{ gap: 5 }}>
          <Label>Cost to hire (£)</Label>
          <TextInput value={cost} onChangeText={setCost} keyboardType="decimal-pad"
            style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 13, fontSize: 16, color: t.ink }} />
          <Note>
            {venue?.pricePence === 0
              ? `${venue.name} is free — but put something in if you're all chipping in for kit.`
              : `${venue?.name} is about £${(venue?.pricePence ?? 0) / 100}.`}
            {" "}Leave it at 0 for a free game. You pay the venue; everyone pays you back.
          </Note>
        </View>

        <Pressable onPress={() => setRepeats((r) => !r)}>
          <Block>
            <Row left={<Text style={{ fontWeight: "700", color: t.ink }}>🔁 Repeats every week</Text>}
                 right={<Tag tone={repeats ? "good" : "plain"}>{repeats ? "Yes" : "No"}</Tag>} />
            <Note>Most real sport is a standing fixture. We'll ask your regulars in or out, every week.</Note>
          </Block>
        </Pressable>

        <Pressable onPress={() => setApprove((a) => !a)}>
          <Block>
            <Row left={<Text style={{ fontWeight: "700", color: t.ink }}>🔒 I approve who joins</Text>}
                 right={<Tag tone={approve ? "good" : "plain"}>{approve ? "Yes" : "No"}</Tag>} />
            <Note>
              People ask; you see their level and their record, and decide. The venue and the group
              only open up once you let them in.
            </Note>
          </Block>
        </Pressable>

        <View style={{ gap: 5 }}>
          <Label>Anything else?</Label>
          <TextInput value={note} onChangeText={setNote} multiline
            placeholder="Beginners welcome, we're not serious" placeholderTextColor={t.ink3}
            style={{
              borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 13,
              fontSize: 15, color: t.ink, minHeight: 64, textAlignVertical: "top",
            }} />
        </View>

        <Button
          label="Post it"
          disabled={!title.trim() || !isValidPlayerCount(n) || !venueId}
          onPress={() => onPost({
            sportId, venueId, title: title.trim(),
            spotsNeeded: n,
            costPence: Math.round(parseFloat(cost || "0") * 100),
            repeatsWeekly: repeats, approveRequired: approve, note: note.trim(),
          })}
        />
        {!isValidPlayerCount(n) && <Note tone="amber">A game needs between 2 and 50 people.</Note>}
      </Body>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ Admin */

/**
 * The admin console.
 *
 * Two things, and the second is the one that matters.
 *
 * 1. Every "I want this" tap lands here, in front of a human. It is not a silent
 *    counter. In the early days the founder IS the growth engine, and a request
 *    that nobody answers is a keen person who has already gone.
 *
 * 2. WHERE TO OPEN NEXT — ranked by the BEST SINGLE POSTCODE, never the total.
 *    "34 people in Leicester want padel" is a vanity number: spread across five
 *    postcodes, not one of them can get a game. Launch on the strength of that
 *    34 and you open three empty courts in three places. The only figure that
 *    means anything is the biggest pile in one place.
 */
export function Admin({ requests, demand, sports, onBack, onReply }: {
  requests: SportRequest[]; demand: SportDemand[]; sports: Sport[];
  onBack: () => void; onReply: (id: string) => void;
}) {
  const t = useTheme();
  const unanswered = requests.filter((r) => !r.answered);
  const sportOf = (id: SportId) => sports.find((s) => s.id === id);

  // Rank the locked sports by their best single area. Not the total. Never the total.
  const board = sports
    .filter((s) => !s.globallyLive)
    .map((s) => ({ sport: s, best: bestAreaFor(s.id, demand) }))
    .filter((x) => !!x.best)
    .sort((a, b) =>
      (b.best!.wantCount / b.best!.threshold) - (a.best!.wantCount / a.best!.threshold));

  return (
    <Screen>
      <Nav title="Admin" sub="Leicester · every request lands here" onBack={onBack} />
      <Body>
        <View style={{ backgroundColor: t.ink, borderRadius: 14, padding: 15 }}>
          <Text style={{ color: t.paper, fontSize: 13.5, lineHeight: 20 }}>
            <Text style={{ fontWeight: "800" }}>{unanswered.length}</Text>
            {unanswered.length === 1 ? " request" : " requests"} waiting on you.
            {"\n"}Demand below is broken down by <Text style={{ fontWeight: "800" }}>postcode</Text> —
            because a sport doesn't open "in Leicester". It opens in LE18, or it doesn't open at all.
          </Text>
        </View>

        <Label>Requests</Label>
        {requests.length === 0 && <Note>Nobody has asked for a sport yet.</Note>}
        {requests.map((r) => {
          const s = sportOf(r.sportId);
          return (
            <Card key={r.id} tone={r.answered ? "plain" : "ask"} onPress={() => onReply(r.id)}>
              <Row
                left={
                  <View>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: t.ink }}>
                      {r.personName}
                    </Text>
                    <Text style={{ fontSize: 12, color: t.ink2 }}>
                      wants {s?.emoji} {s?.name.toLowerCase()} · {r.areaId}
                    </Text>
                  </View>
                }
                right={
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Tag tone={r.answered ? "plain" : "new"}>
                      {r.answered ? "Replied" : "Needs a reply"}
                    </Tag>
                    {/* demand in THEIR postcode — the only number that means anything */}
                    <Tag>{r.demandHere}/{r.threshold} in {r.areaId}</Tag>
                  </View>
                }
              />
            </Card>
          );
        })}

        <Label>Where to open next</Label>
        <Note>
          Ranked by the best single area, not the total. Twelve padel players spread over five
          postcodes isn't a market — it's five empty courts.
        </Note>

        {board.map(({ sport, best }) => (
          <Block key={sport.id}>
            <Row
              left={
                <Text style={{ fontSize: 15, fontWeight: "700", color: t.ink }}>
                  {sport.emoji} {sport.name}
                </Text>
              }
              right={
                <Text style={{ fontSize: 14, fontWeight: "800", color: t.ink }}>
                  {best!.wantCount}/{best!.threshold} in {best!.areaId}
                </Text>
              }
            />
            <Meter value={best!.wantCount} max={best!.threshold}
                   tone={best!.wantCount / best!.threshold > 0.8 ? "close" : undefined} />

            {/* the per-postcode breakdown — where the decision actually gets made */}
            {demand
              .filter((d) => d.sportId === sport.id)
              .sort((a, b) => b.wantCount - a.wantCount)
              .map((d) => (
                <View key={d.areaId} style={[styles.row, { gap: 8 }]}>
                  <Text style={{
                    width: 42, fontSize: 11.5, fontWeight: "700",
                    color: d.areaId === best!.areaId ? t.accent : t.ink3,
                  }}>{d.areaId}</Text>
                  <View style={{ flex: 1 }}>
                    <Meter value={d.wantCount} max={best!.threshold} />
                  </View>
                  <Text style={{
                    width: 26, textAlign: "right", fontSize: 11.5, fontWeight: "700", color: t.ink2,
                  }}>{d.wantCount}</Text>
                </View>
              ))}

            <Note tone={best!.threshold - best!.wantCount === 1 ? "amber" : undefined}>
              {best!.threshold - best!.wantCount <= 0
                ? `${sport.name} is ready to open in ${best!.areaId}.`
                : `${best!.threshold - best!.wantCount} more ${
                    best!.threshold - best!.wantCount === 1 ? "person" : "people"
                  } in ${best!.areaId} and ${sport.name.toLowerCase()} opens there. ` +
                  `${demand.filter((d) => d.sportId === sport.id).length} postcodes tracked.`}
            </Note>
          </Block>
        ))}
      </Body>
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════ You */


export function You({ name, area, radius, attended, missed, onRadius, onAdmin }: {
  name: string; area: string; radius: number; attended: number; missed: number;
  onRadius: (m: number) => void; onAdmin: () => void;
}) {
  const t = useTheme();
  const r = reliability({ gamesAttended: attended, gamesMissed: missed });
  return (
    <Screen>
      <Nav title="You" />
      <Body>
        <View style={{ alignItems: "center", gap: 6, paddingVertical: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: "800", color: t.ink }}>{name}</Text>
          <Text style={{ fontSize: 12.5, color: t.ink3 }}>{area}</Text>
          <Tag tone={r.concerning ? "warn" : "good"}>Turned up to {r.text}</Tag>
        </View>

        <Block title="Search radius">
          <View style={styles.chips}>
            {[3, 5, 10, 15, 25].map((m) => (
              <Chip key={m} label={`${m} miles`} on={radius === m} onPress={() => onRadius(m)} />
            ))}
          </View>
          <Note>
            25 miles is the hard cap, and the database enforces it — past that you're not finding a
            neighbour, you're finding a stranger you'll drive an hour to meet once.
          </Note>
        </Block>

        <Block title="Admin">
          <Button label="Requests and demand" kind="ghost" onPress={onAdmin} />
          <Note>
            Every "I want this" tap lands in front of a human. And demand is broken down by
            postcode, because that is the only level at which a sport can actually open.
          </Note>
        </Block>

        <Block title="Prototype">
          <Note>
            Running on MockRepo — no accounts, no API keys, nothing leaves this phone. Swap one line
            in App.tsx for SupabaseRepo when the backend is live.
          </Note>
        </Block>
      </Body>
    </Screen>
  );
}

export { Tabs };
