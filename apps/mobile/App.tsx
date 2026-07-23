/**
 * App.tsx
 *
 * THE ONE LINE THAT MATTERS is the `repo` below.
 *
 * Today it is a MockRepo: the whole app runs on this phone with no Supabase
 * account, no API key and no network. Every screen is written against the
 * `Repo` interface, and MockRepo is deliberately no more permissive than the
 * Postgres RLS — so when the backend goes live, swapping in SupabaseRepo is a
 * one-line change here and nothing else moves.
 */
import React, { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, View, Alert, ActivityIndicator, useColorScheme, Linking } from "react-native";
import {
  MockRepo, type Repo, type Profile, type Sport, type SportId,
  type PublicGame, type Game, type Person, type SportDemand, type Venue,
  type WeeklyPrompt, type SportRequest,
} from "@hangout/shared";
import {
  Welcome, PickSports, Home, GameDetail, Sports, People, PostGame, You, Admin, Tabs,
} from "./src/screens";
import { useTheme } from "./src/theme";
import { confirmDestructive } from "./src/ui";

// ─────────────────────────────────────────────────────────────────────────
// SWAP THIS LINE when the backend is live:
//     const repo: Repo = new SupabaseRepo(url, anonKey);
// Nothing else in the app changes.
const repo: Repo = new MockRepo();
// ─────────────────────────────────────────────────────────────────────────

type Route =
  | { name: "welcome" } | { name: "pick" } | { name: "home" }
  | { name: "game"; id: string } | { name: "post" }
  | { name: "sports" } | { name: "people" } | { name: "you" } | { name: "admin" };

const TABS = new Set(["home", "sports", "people", "you"]);

export default function App() {
  const t = useTheme();
  const scheme = useColorScheme();

  const [route, setRoute] = useState<Route>({ name: "welcome" });
  const [stack, setStack] = useState<Route[]>([]);
  const [me, setMe] = useState<Profile | null>(null);
  const [sports, setSports] = useState<Sport[]>([]);
  const [games, setGames] = useState<PublicGame[]>([]);
  const [game, setGame] = useState<Game | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [prompts, setPrompts] = useState<WeeklyPrompt[]>([]);
  const [requests, setRequests] = useState<SportRequest[]>([]);
  const [demand, setDemand] = useState<SportDemand[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [postSport, setPostSport] = useState<SportId>("badminton");
  const [busy, setBusy] = useState(true);

  const go = (r: Route) => {
    if (TABS.has(r.name)) setStack([]);
    else setStack((s) => [...s, route]);
    setRoute(r);
  };
  const back = () => {
    const prev = stack[stack.length - 1];
    setStack((s) => s.slice(0, -1));
    setRoute(prev ?? { name: "home" });
  };

  const refresh = useCallback(async () => {
    const [p, s, d] = await Promise.all([repo.me(), repo.sports(), repo.demand()]);
    setMe(p);
    setSports(s);
    setDemand(d);
    if (p) {
      setGames(await repo.gamesNearMe());
      setPeople(await repo.peopleNearMe());
      setPrompts(await repo.weeklyPrompts());
      if (p.isAdmin) setRequests(await repo.sportRequests());
    }
    setBusy(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const reloadGame = useCallback(async (id: string) => {
    setGame(await repo.game(id));
    setGames(await repo.gamesNearMe());
    setPrompts(await repo.weeklyPrompts());
  }, []);

  const openGame = useCallback(async (id: string) => {
    setGame(await repo.game(id));
    setStack((s) => [...s, route]);
    setRoute({ name: "game", id });
  }, [route]);

  const join = useCallback(async (id: string) => {
    const outcome = await repo.joinGame(id);
    await reloadGame(id);
    const msg: Record<string, string> = {
      joined: "You're in.",
      asked: "Asked. The host sees your level and your record, and decides — not us.",
      waitlisted: "You're on the waitlist. If someone drops out you're in automatically, and nobody has to ask.",
      already_in: "You're already in this one.",
      already_asked: "You've already asked. Waiting on the host.",
      cancelled: "That game was called off.",
      not_live: "That sport isn't open near you yet.",
    };
    Alert.alert(msg[outcome] ?? outcome);
  }, [reloadGame]);

  if (busy) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.card, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={t.accent} />
      </SafeAreaView>
    );
  }

  const sportOf = (id: string) => sports.find((s) => s.id === id);
  let screen: React.ReactNode = null;

  if (!me) {
    screen = route.name === "pick"
      ? (
        <PickSports
          sports={sports}
          demand={demand}
          onDone={async (name, picked) => {
            await repo.signUp({ name, areaId: "LE18", sports: picked });
            await refresh();
            setStack([]);
            setRoute({ name: "home" });
          }}
        />
      )
      : (
        <Welcome
          onCreate={() => setRoute({ name: "pick" })}
          onSignIn={async () => {
            await repo.signUp({ name: "Shiv", areaId: "LE18", sports: ["badminton", "cricket"] });
            await refresh();
            setRoute({ name: "home" });
          }}
        />
      );
  } else if (route.name === "game") {
    screen = game ? (
      <GameDetail
        game={game}
        sport={sportOf(game.sportId)}
        onBack={back}
        onJoin={() => void join(route.id)}
        onLeave={async () => { await repo.leaveGame(route.id); await reloadGame(route.id); back(); }}
        onAccept={async (pid) => { await repo.acceptAsk(route.id, pid); await reloadGame(route.id); }}
        onSend={async (body) => { await repo.sendMessage(route.id, body); await reloadGame(route.id); }}
      />
    ) : null;
  } else if (route.name === "post") {
    screen = (
      <PostGame
        sports={sports}
        venues={venues}
        sportId={postSport}
        onPickSport={async (s) => { setPostSport(s); setVenues(await repo.venuesFor(s)); }}
        onBack={back}
        onPost={async (input) => {
          const id = await repo.postGame({
            ...input,
            startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
          });
          setGames(await repo.gamesNearMe());
          setStack([]);
          await openGame(id);
        }}
      />
    );
  } else if (route.name === "sports") {
    screen = (
      <Sports
        sports={sports}
        demand={demand}
        onWant={async (id) => {
          const tipped = await repo.wantSport(id);
          await refresh();
          const s = sportOf(id)!;
          Alert.alert(
            tipped ? `${s.emoji} ${s.name} just went live in LE18` : "Counted.",
            tipped
              ? `You were number ${s.launchThreshold}. That's the threshold — enough people near LE18 that a shout actually gets answered.\n\nA sport doesn't exist here until it has the density to work, because otherwise every new sport just splits your neighbours across more empty rooms.\n\nThe first game is already up.`
              : "We'll tell you the moment it opens — and a real person sees your request.",
          );
        }}
      />
    );
  } else if (route.name === "admin") {
    screen = (
      <Admin
        requests={requests}
        demand={demand}
        sports={sports}
        onBack={back}
        onReply={async (id) => {
          await repo.replyToRequest(id, "Thanks — I'll shout the moment it opens.");
          await refresh();
          Alert.alert("Replied",
            "In the real app this opens a thread. The point is that a human sees the request and a human answers it.");
        }}
      />
    );
  } else if (route.name === "people") {
    screen = (
      <People
        people={people}
        onBlock={(id, name) => confirmDestructive(
          `Block ${name}?`,
          "You will not see each other anywhere in the app, and neither of you can join the other's games.",
          "Block",
          async () => { await repo.blockUser(id); await refresh(); },
        )}
        onReport={(id, name) => confirmDestructive(
          `Report ${name}?`,
          "We read every report within 24 hours. Reporting also blocks them straight away — you should not have to keep seeing someone while we look.",
          "Report",
          async () => {
            await repo.reportUser(id, "reported from People");
            await refresh();
          },
        )}
      />
    );
  } else if (route.name === "you") {
    screen = (
      <You
        name={me.displayName}
        area={me.areaId}
        radius={me.radiusMiles}
        attended={me.gamesAttended}
        missed={me.gamesMissed}
        onRadius={async (m) => { await repo.setRadius(m); await refresh(); }}
        onAdmin={() => go({ name: "admin" })}
        onPrivacy={() => Linking.openURL("https://yourmedicals-tech.github.io/hangout/privacy.html")}
        onDelete={() => confirmDestructive(
          "Delete your account?",
          "This removes your profile, your games and your messages immediately. It cannot be undone.",
          "Delete",
          async () => {
            await repo.deleteMyAccount();
            await refresh();
            setStack([]);
            setRoute({ name: "welcome" });
          },
        )}
      />
    );
  } else {
    screen = (
      <Home
        games={games}
        prompts={prompts}
        onOut={async (id) => {
          await repo.cantMakeIt(id);
          await reloadGame(id);
          Alert.alert("Told them", "You are still a regular — just out this week.");
        }}
        radiusMiles={me.radiusMiles}
        area={me.areaId}
        onOpen={(id) => void openGame(id)}
        onJoin={(id) => void join(id)}
        onPost={async () => { setVenues(await repo.venuesFor(postSport)); go({ name: "post" }); }}
      />
    );
  }

  const showTabs = !!me && TABS.has(route.name);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.card }}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <View style={{ flex: 1 }}>{screen}</View>
      {showTabs && (
        <Tabs
          active={route.name}
          onSelect={(k) => { setStack([]); setRoute({ name: k } as Route); }}
        />
      )}
    </SafeAreaView>
  );
}
