// Zen Staff web dashboard (/app). Vanilla, no build step: it draws the pages with the DOM (never
// innerHTML with data) and calls the hub's JSON API with the session cookie. Every request carries
// `x-zen-web: 1`; the hub only accepts the cookie on such requests (src/webSession.ts).
// Look: the landing's "Registru" system (app.css). Texts: DICT.ro and DICT.en, same keys and the
// same {placeholders} (test/i18n.test.ts checks both); `t()` falls back to Romanian.

const DICT = {
  ro: {
    "nav.home": "Acasă",
    "nav.company": "Firma",
    "nav.team": "Echipă",
    "nav.devices": "Dispozitive",
    "nav.staff": "Angajați AI",
    "nav.packs": "Pachetele firmei",
    "nav.security": "Securitate",
    "nav.plan": "Plan",
    "nav.library": "Bibliotecă",
    "nav.review": "Verificare",
    "nav.more": "Mai mult",
    "nav.menu": "Meniu",
    "nav.collapse": "Restrânge bara laterală",
    "nav.expand": "Deschide bara laterală",
    "nav.logout": "Ieși din cont",
    "nav.pages": "Pagini",
    "nav.switch": "Schimbă firma",
    "nav.newCompany": "Creează o firmă",
    "nav.account": "Contul tău",
    "role.owner": "Owner",
    "role.admin": "Admin",
    "role.member": "Membru",
    "role.guest": "Invitat",
    "plan.hosted": "Găzduit",
    "plan.selfhost": "Self-host",
    "plan.trial": "Perioadă de test",
    "plan.free": "Gratuit",
    "common.save": "Salvează",
    "common.saved": "Salvat.",
    "common.copy": "Copiază",
    "common.copied": "Copiat",
    "common.online": "Online",
    "common.offline": "Offline",
    "common.never": "niciodată",
    "common.sure": "Sigur?",
    "common.remove": "Scoate",
    "common.retry": "Încearcă din nou",
    "common.loadFailed": "Nu am putut încărca datele de la hub.",
    "fatal.title": "Hubul nu",
    "fatal.accent": "răspunde",
    "common.seeAll": "Vezi tot",
    "common.now": "acum",
    "common.minAgo": "acum {n} min",
    "common.hAgo": "acum {n} h",
    "common.today": "azi",
    "common.download": "Descarcă Zen Staff",
    "common.yes": "da",
    "common.no": "nu",
    "login.title": "Intră în",
    "login.titleAccent": "cont",
    "login.lead": "Contul tău de echipă Zen Staff: firma, colegii, dispozitivele și angajații AI.",
    "login.email": "Adresa de e-mail",
    "login.send": "Trimite codul",
    "login.or": "sau",
    "login.passkey": "Intră cu cheia de acces",
    "login.passkeyNo": "Browserul acesta nu suportă chei de acces.",
    "login.passkeyCancelled": "Anulat sau expirat. Încearcă din nou.",
    "login.passkeyRefused": "Cheia de acces nu a fost acceptată. Poate a fost ștearsă; intră cu codul pe e-mail.",
    "login.codeTitle": "Verifică",
    "login.codeAccent": "e-mailul",
    "login.codeLead": "Am trimis un cod de 6 cifre la {email}. Scrie-l aici sau deschide linkul din e-mail pe orice dispozitiv.",
    "login.code": "Codul din e-mail",
    "login.enter": "Intră",
    "login.other": "Altă adresă",
    "login.waitingLink": "Așteptăm și linkul din e-mail; pagina continuă singură când îl deschizi.",
    "login.note": "Fără parolă: primești un cod pe e-mail sau folosești o cheie de acces (amprentă, față, PIN).",
    "login.landing": "Despre Zen Staff",
    "login.quote1": "Nimic nu pleacă fără",
    "login.quoteAccent": "acordul",
    "login.quote2": "șefului.",
    "login.glimpseWho": "Ana",
    "login.glimpseRole": "Contabilitate",
    "login.glimpseChip": "Cere acordul",
    "login.glimpseTitle": "Trimite facturi-octombrie-2026.xlsx contabilului",
    "login.glimpseMeta": "Aprobat de Andrei, acum 2 min",
    "twofa.verifyTitle": "Al doilea",
    "twofa.verifyAccent": "pas",
    "twofa.verifyLead": "Contul tău are autentificarea în doi pași pornită. Scrie codul de 6 cifre din aplicația de autentificare.",
    "twofa.code": "Cod de 6 cifre",
    "twofa.useRecovery": "Folosește un cod de recuperare",
    "twofa.useCode": "Folosește codul din aplicație",
    "twofa.recovery": "Cod de recuperare",
    "twofa.check": "Verifică",
    "twofa.setupTitle": "Pornește",
    "twofa.setupAccent": "doi pași",
    "twofa.setupLead": "Ca owner sau admin al unei firme, intri cu un al doilea pas: un cod din aplicația de autentificare (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden).",
    "twofa.scan": "Scanează codul QR cu aplicația, apoi scrie codul pe care ți-l arată.",
    "twofa.manual": "Nu poți scana? Adaugă manual cheia:",
    "twofa.enable": "Pornește",
    "twofa.codesTitle": "Codurile de",
    "twofa.codesAccent": "recuperare",
    "twofa.codesLead": "Dacă pierzi telefonul, intri cu unul dintre aceste coduri. Fiecare merge o singură dată. Păstrează-le într-un manager de parole sau tipărite, nu pe același telefon.",
    "twofa.codesDone": "Am salvat codurile, continuă",
    "twofa.copyCodes": "Copiază codurile",
    "home.morning": "Bună dimineața,",
    "home.day": "Bună ziua,",
    "home.evening": "Bună seara,",
    "home.invite": "Invită un coleg",
    "home.kpiTasks": "Sarcini AI, 7 zile",
    "home.kpiTasksSub": "{d} față de săpt. trecută",
    "home.kpiTasksSame": "la fel ca săptămâna trecută",
    "home.kpiMembers": "Oameni în firmă",
    "home.kpiMembersSub": "+{n} în ultimele 30 de zile",
    "home.kpiDevices": "Dispozitive online",
    "home.kpiDevicesNone": "niciun calculator încă",
    "home.kpiApprovals": "De aprobat",
    "home.kpiApprovalsNone": "totul e semnat",
    "home.kpiApprovalsSome": "așteaptă semnătura ta",
    "home.kpiGuest": "doar pentru membri",
    "home.approvals": "De aprobat",
    "home.waiting": "{n} în așteptare",
    "home.approvalsEmpty": "Nimic de aprobat. Când un coleg intră pe un calculator nou sau îți predă o conversație, apare aici.",
    "home.approvalsNote": "Aprobările pentru munca angajaților AI (e-mailuri, documente, plăți) sunt în aplicație: conținutul lor e criptat cap-coadă și hubul nu îl vede.",
    "home.apDevice": "Dispozitiv nou",
    "home.apDeviceTitle": "{device}, semnalat de runnerul „{runner}”",
    "home.apDeviceHow": "Verifică amprenta cu {name}, apoi aprobă din aplicație sau pe runner.",
    "home.apDeviceHowMine": "E noul tău calculator. Îl aprobi din aplicație, pe un calculator deja aprobat, sau îl aprobă cel care ține runnerul.",
    "home.apHandover": "Predare",
    "home.apHandoverTitle": "{name} îți predă o conversație",
    "home.apHandoverHow": "O preiei sau o refuzi în aplicație, la Echipă > Primite.",
    "home.apInvite": "Invitație",
    "home.apInviteTitle": "Intră în {company} ca {role}",
    "home.apInvitesSent": "Invitații trimise",
    "home.apInvitesSentTitle": "{n} colegi nu au acceptat încă",
    "home.apInvitesSentOne": "Un coleg nu a acceptat încă",
    "home.apInvitesSentHow": "Le poți trimite din nou linkul sau le anulezi.",
    "home.stampWaiting": "Așteaptă",
    "home.stampApproved": "Aprobat",
    "home.openTeam": "Vezi echipa",
    "home.activity": "Activitatea angajaților AI",
    "home.days7": "7 zile",
    "home.days30": "30 zile",
    "home.tasks": "sarcini prin hub",
    "home.tasksDay": "{n} sarcini",
    "home.changes": "modificări de profil",
    "home.shares": "conversații partajate",
    "home.comments": "comentarii",
    "home.activityNote": "Hubul vede doar metadate: câte, când și cine. Ce scriu angajații AI rămâne criptat între aplicații și runner.",
    "home.activityEmptyT": "Încă nicio sarcină prin hub",
    "home.activityEmpty": "Dă prima sarcină unui angajat AI din aplicație, din chatul firmei: @ și numele lui. Aici apare câte ai trimis pe zi.",
    "home.activityGuest": "Invitații nu văd activitatea angajaților AI.",
    "home.runner": "Runnerul firmei",
    "home.runnerOn": "Online, primește sarcini",
    "home.runnerOff": "Offline, văzut {when}",
    "home.runnerOwner": "Calculatorul lui",
    "home.runnerAccount": "Contul AI",
    "home.runnerStaff": "Angajați AI ținuți",
    "home.runnerNoneT": "Firma nu are încă un runner",
    "home.runnerStep1": "Instalează Zen Staff pe calculatorul care rămâne pornit la birou.",
    "home.runnerStep2": "Intră cu contul tău, pe acest hub.",
    "home.runnerStep3": "Echipă > Firme > Fă-l runnerul firmei.",
    "home.timeline": "Ce s-a întâmplat",
    "home.timelineEmptyT": "Nimic în jurnal încă",
    "home.timelineEmpty": "Jurnalul e gol. Aici apar invitațiile, rolurile, runnerele și pachetele, pe măsură ce se schimbă.",
    "home.timelineMine": "Jurnalul firmei îl văd ownerii și adminii; aici sunt evenimentele contului tău.",
    "home.packs": "Pachetele firmei",
    "home.packsEmptyT": "Niciun pachet pentru toată firma",
    "home.packsEmpty": "Un admin instalează pachete pentru toți din aplicație: Magazin > Instalează pentru firmă.",
    "home.packHealth": "{ok} din {n} calculatoare",
    "home.packNoStatus": "niciun calculator nu a raportat încă",
    "home.packOk": "Merge",
    "home.packBad": "Eroare",
    "home.packWait": "Se instalează",
    "home.team": "Echipa",
    "home.teamEmptyT": "Ești singur în firmă",
    "home.teamEmpty": "Invită colegii: primesc un e-mail sau un link și intră cu adresa lor. Fiecare loc pornește în perioada de test.",
    "home.staff": "Angajații AI",
    "home.staffEmptyT": "Niciun angajat AI al firmei",
    "home.staffEmpty": "Îi creezi în aplicație, la Angajați > Nou > Pentru toată firma. Aici vezi cine e și pe ce runner stă.",
    "home.staffBy": "manager {name}",
    "home.myDevices": "Calculatoarele tale",
    "home.myDevicesEmptyT": "Niciun calculator conectat",
    "home.myDevicesEmpty": "Instalează Zen Staff și intră cu același cont; calculatorul apare aici.",
    "home.lastSeen": "văzut {when}",
    "home.neverSeen": "neconectat încă",
    "home.noCompany": "Bun venit în",
    "home.noCompanyAccent": "Zen Staff",
    "home.noCompanyLead": "Creează firma ta sau acceptă o invitație de la un coleg.",
    "company.title": "Datele",
    "company.titleAccent": "firmei",
    "company.name": "Numele firmei",
    "company.rename": "Redenumește",
    "company.identity": "Firma",
    "company.since": "{n} oameni · {role}",
    "company.details": "Date pentru facturare",
    "company.detailsLead": "Le folosim pentru facturi când pornesc plățile. Le vede toată echipa; le schimbă doar ownerii și adminii.",
    "company.legalName": "Denumire juridică",
    "company.taxId": "CUI",
    "company.registryNo": "Nr. Registrul Comerțului",
    "company.address": "Adresă",
    "company.city": "Oraș",
    "company.county": "Județ",
    "company.country": "Țară",
    "company.billingEmail": "E-mail pentru facturi",
    "company.create": "Creează o firmă",
    "company.createLead": "Tu devii owner. Apoi inviți colegii și alegi calculatorul care ține angajații AI ai firmei.",
    "company.createButton": "Creează firma",
    "company.createAnother": "Altă firmă",
    "company.createAnotherLead": "Lucrezi pentru mai multe firme? Fiecare are echipa, runnerul și angajații ei.",
    "company.readOnly": "Doar ownerii și adminii schimbă datele firmei.",
    "company.filled": "{n} din 8 completate",
    "team.title": "Oamenii din",
    "team.titleAccent": "firmă",
    "team.members": "Membri",
    "team.you": "tu",
    "team.leave": "Ieși din firmă",
    "team.since": "din {date}",
    "team.twofaOn": "doi pași pornit",
    "team.twofaOff": "fără doi pași",
    "team.invite": "Invită un coleg",
    "team.inviteEmail": "Pe e-mail",
    "team.inviteEmailLead": "Primește un e-mail cu invitația; o acceptă intrând cu adresa asta.",
    "team.inviteSend": "Trimite invitația",
    "team.inviteSent": "Invitația a plecat la {email}.",
    "team.inviteLink": "Prin link",
    "team.inviteLinkLead": "Un link pe care îl trimiți tu, pe orice canal. Merge o singură dată, 14 zile.",
    "team.inviteLinkMake": "Creează linkul",
    "team.inviteLinkOnce": "Copiază-l acum: din motive de securitate hubul nu îl mai poate arăta.",
    "team.email": "E-mail",
    "team.role": "Rol",
    "team.pending": "Invitații în așteptare",
    "team.pendingNone": "Nicio invitație în așteptare. Cele trimise apar aici până le acceptă cineva.",
    "team.pendingLink": "link de invitație",
    "team.revoke": "Anulează",
    "team.roleHelp": "Owner: tot, inclusiv alți owneri. Admin: echipa, runnerul, pachetele. Membru: lucrează cu angajații AI. Invitat: vede doar ce i se partajează.",
    "team.inviteOnlyManagers": "Ownerii și adminii invită colegi. Roagă unul dintre ei să-ți trimită linkul pentru colegul tău.",
    "devices.title": "Calculatoare și",
    "devices.titleAccent": "chei",
    "devices.machines": "Calculatoarele tale",
    "devices.runnerFor": "runnerul {company}",
    "devices.keys": "Cheile dispozitivelor tale",
    "devices.keysLead": "Fiecare aplicație în care intri are o cheie proprie. Runnerele firmei acceptă cereri doar de la chei pe care le cunosc.",
    "devices.keyApproved": "aprobată de alt dispozitiv",
    "devices.keyFirst": "prima cheie sau aprobată pe runner",
    "devices.keyRevoked": "{n} chei vechi, scoase",
    "devices.keysNone": "Nicio cheie încă: apare când intri în aplicația Zen Staff.",
    "devices.approveHow": "Cum aprobi un dispozitiv nou",
    "devices.approveText": "Aprobarea e o semnătură făcută cu cheia unui dispozitiv deja aprobat, ca hubul să nu o poată falsifica. Browserul nu are o astfel de cheie, deci aprobi din aplicație: pe un dispozitiv aprobat, Echipă > Cont > Chei > Aprobă; sau pe runner, Echipă > Cont > Așteaptă aprobare. Aici verifici amprenta și închizi orice sesiune pe care nu o recunoști.",
    "devices.waiting": "Dispozitive care așteaptă aprobare",
    "devices.waitingNone": "Niciun dispozitiv nou semnalat în ultimele 14 zile.",
    "devices.waitingNote": "Runnerul nu anunță hubul când aprobă, așa că o cerere de aici poate fi deja rezolvată pe runner.",
    "devices.sessions": "Sesiuni deschise",
    "devices.sessionCurrent": "sesiunea asta",
    "devices.sessionEnd": "Închide",
    "devices.sessionUsed": "folosită {when}",
    "devices.method.email": "cod pe e-mail",
    "devices.method.passkey": "cheie de acces",
    "devices.method.google": "Google",
    "devices.method.microsoft": "Microsoft",
    "devices.with2fa": "cu doi pași",
    "staff.title": "Angajații",
    "staff.titleAccent": "AI",
    "staff.lead": "Angajații AI ai firmei, sincronizați prin hub.",
    "staff.count": "{n} angajați AI ai firmei",
    "staff.lastChange": "ultima schimbare {when}",
    "staff.sealedT": "Profilurile sunt sigilate",
    "staff.sealed": "Numele, rolul, instrucțiunile și regulile fiecărui angajat AI sunt criptate pentru runnerele firmei. Hubul, deci și pagina asta, vede doar identificatorul, versiunea, managerul și când s-a schimbat. Îi creezi și îi editezi în aplicație, la Angajați.",
    "staff.manager": "Manager",
    "staff.noManager": "fără manager",
    "staff.runsOn": "Stă pe",
    "staff.updated": "schimbat {when}",
    "staff.updatedBy": "schimbat {when} de {name}",
    "staff.none": "Firma nu are încă angajați AI pentru toată echipa. Îi adaugi din aplicație: Angajați > Nou > Pentru toată firma.",
    "staff.guest": "Invitații nu văd angajații AI ai firmei.",
    "packs.title": "Pachetele",
    "packs.titleAccent": "firmei",
    "packs.lead": "Pachetele instalate pentru toată firma și starea lor pe fiecare calculator.",
    "packs.how": "Instalezi, actualizezi și scoți pachete pentru toată firma din aplicație: cererea e semnată cu cheia dispozitivului unui admin.",
    "packs.by": "instalat de {name}, {date}",
    "packs.enterprise": "Enterprise, doar pe runner",
    "packs.none": "Niciun pachet instalat pentru toată firma. Un admin le instalează din aplicație: Magazin > Instalează pentru firmă.",
    "packs.statusNone": "Încă niciun calculator nu a raportat starea.",
    "packs.state.installing": "Se instalează",
    "packs.state.installed": "Instalat",
    "packs.state.failed": "Eroare",
    "packs.state.runner-only": "Doar pe runner",
    "packs.mineOnly": "Vezi doar calculatoarele tale; adminii văd toată firma.",
    "security.title": "Contul și",
    "security.titleAccent": "securitatea",
    "security.account": "Contul tău",
    "security.yourName": "Numele tău",
    "security.twofa": "Autentificare în doi pași",
    "security.twofaOn": "Pornită",
    "security.twofaOff": "Oprită",
    "security.twofaRequired": "Obligatorie pentru owneri și admini.",
    "security.twofaOptional": "Opțională pentru tine; o recomandăm.",
    "security.codesLeft": "{n} coduri de recuperare rămase",
    "security.newCodes": "Generează coduri noi",
    "security.newCodesLead": "Codurile vechi nu mai merg. Confirmă cu un cod din aplicație.",
    "security.disable": "Oprește",
    "security.disableLead": "Confirmă cu un cod din aplicație.",
    "security.passkeys": "Chei de acces",
    "security.passkeysLead": "Intri cu amprenta, fața sau PIN-ul dispozitivului, fără cod pe e-mail. Contează ca doi pași.",
    "security.passkeysNone": "Nicio cheie de acces încă. Adaug-o pe calculatorul pe care îl folosești zilnic.",
    "security.passkeyAdd": "Adaugă o cheie de acces",
    "security.passkeyName": "Nume (de ex. Laptop birou)",
    "security.passkeyOpened": "Am deschis pagina cheii de acces într-o filă nouă. Când ai terminat, revino aici.",
    "security.passkeyLastUsed": "folosită {when}",
    "security.passkeySynced": "sincronizată",
    "security.audit": "Jurnal de securitate",
    "security.auditNone": "Nimic în jurnal încă.",
    "security.auditWhen": "Când",
    "security.auditWho": "Cine",
    "security.auditWhat": "Ce",
    "security.auditDetail": "Detalii",
    "plan.title": "Planul",
    "plan.titleAccent": "firmei",
    "plan.yours": "Planul firmei",
    "plan.seatsCost": "Locuri și cost",
    "plan.seats": "Locuri ocupate",
    "plan.seatsLead": "Ownerii, adminii și membrii ocupă un loc; invitații nu.",
    "plan.guests": "Invitați, fără cost",
    "plan.monthly": "După perioada de test, pe lună",
    "plan.after": "După perioada de test: {total} € / lună pentru {n} locuri.",
    "plan.trialLead": "Plățile nu sunt pornite încă. Pe perioada de test nu plătești nimic și nu îți cerem cardul.",
    "plan.selfhostLead": "Hubul acesta e găzduit de firma ta. Self-host e gratuit.",
    "plan.invoices": "Facturi",
    "plan.invoicesNoneT": "Încă nu ai facturi",
    "plan.invoicesNone": "Vor apărea aici, pe datele de la Firma. Verifică acum că sunt corecte.",
    "plan.checkDetails": "Datele de facturare",
    "plan.personal": "Personal",
    "plan.personalFor": "pentru oricine, pe orice calculator",
    "plan.personal1": "Agenți nelimitați, cu contul tău AI",
    "plan.personal2": "Pachetele de lucru din magazin",
    "plan.personal3": "Windows, macOS, Linux, Android",
    "plan.personalNote": "Fără hub: fără chaturi de echipă, memorie comună și aprobări.",
    "plan.selfhostFor": "pentru firma ta, pe serverul tău",
    "plan.selfhost1": "Hubul complet, pe serverul vostru",
    "plan.selfhost2": "Chaturile echipei, memoria comună, aprobări",
    "plan.selfhost3": "Angajații AI ai firmei, agenți nelimitați",
    "plan.selfhostNote": "Gratuit pentru firma voastră; nu îl puteți revinde ca serviciu găzduit.",
    "plan.hostedName": "Echipă",
    "plan.hostedFor": "/ utilizator / lună",
    "plan.hosted1": "Hubul și memoria firmei, găzduite de noi",
    "plan.hosted2": "Actualizări, backup și suport incluse",
    "plan.hosted3": "Agenți nelimitați; plătiți doar oamenii",
    "plan.hostedNote": "Agenții rulează tot la voi, pe calculatoarele firmei.",
    "plan.current": "planul firmei",
    "plan.status.none": "neactivat",
    "plan.status.trialing": "perioadă de test",
    "plan.status.active": "activ",
    "plan.status.past_due": "plată restantă",
    "plan.status.unpaid": "neplătit",
    "plan.status.canceled": "anulat",
    "plan.status.paused": "în pauză",
    "plan.status.incomplete": "plată în curs",
    "plan.status.incomplete_expired": "neactivat",
    "plan.sub": "Abonamentul",
    "plan.subLead": "Plătiți doar oamenii: ownerii, adminii și membrii. Invitații și agenții nu costă.",
    "plan.seatsN": "Locuri plătite",
    "plan.servers": "Servere non-stop",
    "plan.nextInvoice": "Următoarea factură, estimat",
    "plan.renews": "Se reînnoiește pe {date}.",
    "plan.endsAt": "Se încheie pe {date}; nu se mai reînnoiește.",
    "plan.trialLeft": "Mai ai {n} zile de test, până pe {date}. Prima plată vine după, pe cardul sau contul salvat.",
    "plan.trialLeft1": "Ultima zi de test: {date}.",
    "plan.upgrade": "Treci pe Găzduit",
    "plan.upgradeTrial": "Pornește cele {n} zile de test",
    "plan.upgradeLead": "{n} locuri x {price} € pe lună. Plătești cu cardul sau prin debit direct SEPA, pe pagina securizată Stripe.",
    "plan.manage": "Gestionează plata",
    "plan.manageLead": "Cardul, adresa, facturile Stripe și anularea, în portalul Stripe.",
    "plan.downloadInvoices": "Facturile",
    "plan.notEnabled": "Plățile nu sunt pornite încă pe acest hub. Până atunci, perioada de test continuă și nu îți cerem cardul.",
    "plan.testMode": "Mod de test Stripe: nicio plată nu e reală.",
    "plan.membersOnly": "Doar ownerii și adminii schimbă planul și plățile.",
    "plan.addonT": "Server non-stop",
    "plan.addonPrice": "{price} € / lună / server",
    "plan.addonLead": "Un server mereu pornit pentru angajații AI ai firmei: lucrează pe program și la declanșatori și când calculatoarele voastre sunt închise. Se conectează singur la hub.",
    "plan.addonSave": "Actualizează",
    "plan.addonAfter": "Îl adaugi după ce pornești abonamentul; diferența se calculează pe zile.",
    "plan.addonAtCheckout": "Servere de inclus din prima zi",
    "plan.packagesT": "Făcut pentru tine",
    "plan.packagesLead": "Echipa ZED-ZEN instalează, conectează și instruiește. O singură plată, fără abonament.",
    "plan.packageUnit": "o singură dată",
    "plan.buy": "Cumpără {name}",
    "plan.packagePaid": "plătit",
    "plan.invoicesLead": "Factura fiscală e emisă de FORTITUDO VINCIT S.R.L. și trimisă în e-Factura (SPV). Chitanța Stripe arată plata cu cardul.",
    "plan.colDate": "Data",
    "plan.colPeriod": "Perioada",
    "plan.colAmount": "Suma",
    "plan.colFiscal": "Factura fiscală",
    "plan.colEfactura": "e-Factura",
    "plan.fiscalPending": "în lucru",
    "plan.fiscalFailed": "de refăcut",
    "plan.fiscalDryRun": "simulare",
    "plan.ef.accepted": "acceptată",
    "plan.ef.rejected": "respinsă",
    "plan.ef.pending": "în trimitere",
    "plan.ef.uploaded": "încărcată",
    "plan.ef.in_processing": "în prelucrare",
    "plan.pdf": "PDF",
    "plan.receipt": "Chitanță",
    "plan.packageKind": "Făcut pentru tine",
    "plan.subscriptionKind": "Abonament",
    "plan.billingT": "Date de facturare",
    "plan.billingLead": "Apar pe factura fiscală. Pentru firmele din România CUI-ul e obligatoriu și îl verificăm după cifra de control; pentru UE, codul de TVA îl verificăm în VIES.",
    "plan.country": "Țara (cod, ex. RO)",
    "plan.vies.valid": "Cod de TVA valid în VIES.",
    "plan.vies.invalid": "VIES nu găsește acest cod de TVA; factura va avea TVA, fără taxare inversă.",
    "plan.vies.unavailable": "VIES nu răspunde acum; verificăm din nou la plată.",
    "plan.vat.not_registered": "Fără TVA: FORTITUDO VINCIT S.R.L. este neplătitor de TVA.",
    "plan.vat.standard": "TVA {rate}% inclus în factură.",
    "plan.vat.reverse_charge": "Taxare inversă: TVA-ul îl declarați voi.",
    "plan.vat.outside_scope": "Fără TVA: client din afara UE.",
    "plan.missing": "Completează datele de facturare înainte de plată.",
    "plan.paidOk": "Mulțumim! Stripe confirmă plata; planul se actualizează în câteva secunde.",
    "plan.paidPackage": "Mulțumim! Pachetul e plătit; te contactăm în cel mult o zi lucrătoare.",
    "plan.paidCancel": "Plata a fost anulată. Nu s-a încasat nimic.",
    "plan.banner.payment_failed": "Plata pentru Găzduit nu a trecut. Actualizează cardul până pe {date}; după aceea funcțiile de echipă trec doar pe citire.",
    "plan.banner.grace_over": "Plata pentru Găzduit e restantă, așa că funcțiile de echipă sunt doar pe citire. Nu s-a șters nimic; plătește din Plan ca să revii.",
    "plan.banner.unpaid": "Abonamentul e neplătit: funcțiile de echipă sunt doar pe citire. Nu s-a șters nimic.",
    "plan.banner.canceled": "Abonamentul Găzduit e anulat: funcțiile de echipă sunt doar pe citire. Datele rămân; îl poți porni din nou din Plan.",
    "plan.banner.paused": "Abonamentul e în pauză: funcțiile de echipă sunt doar pe citire.",
    "plan.banner.pending": "Așteptăm confirmarea primei plăți (debitul SEPA poate dura câteva zile).",
    "plan.bannerGo": "Mergi la Plan",
    "err.code.billing_read_only": "Planul firmei nu e plătit, așa că funcțiile de echipă sunt doar pe citire. Un owner sau admin poate plăti din Plan.",
    "err.code.billing_not_configured": "Plățile nu sunt pornite încă pe acest hub.",
    "err.code.billing_details_missing": "Completează mai întâi datele de facturare.",
    "err.code.invalid_cui": "CUI-ul nu e valid (cifra de control nu se potrivește).",
    "err.code.invalid_vat": "Codul de TVA nu are forma corectă pentru țara aleasă.",
    "err.code.already_subscribed": "Firma are deja planul Găzduit. Îl gestionezi din portalul de plată.",
    "err.code.no_subscription": "Pornește întâi abonamentul.",
    "invite.title": "O",
    "invite.titleAccent": "invitație",
    "invite.lead": "Ai primit un link de invitație într-o firmă pe Zen Staff.",
    "invite.accept": "Acceptă invitația",
    "invite.paste": "Linkul de invitație",
    "invite.accepted": "Ai intrat în {company}.",
    "invite.mine": "Invitații pentru {email}",
    "invite.mineNone": "Nicio invitație pentru adresa ta. Dacă un coleg te-a invitat pe altă adresă, intră cu aceea.",
    "err.wrongCode": "Codul e greșit sau a expirat.",
    "err.wrongTotp": "Codul e greșit sau a fost deja folosit.",
    "err.limited": "Prea multe încercări. Așteaptă câteva minute.",
    "err.email": "Scrie o adresă de e-mail validă.",
    "err.forbidden": "Nu ai drept să faci asta.",
    "err.inviteInvalid": "Invitația nu mai e valabilă.",
    "err.inviteOther": "Invitația e pentru altă adresă. Intră cu adresa la care ai primit-o.",
    "err.generic": "Nu a mers. Încearcă din nou.",
    "err.offline": "Nu ajung la hub. Verifică internetul.",
    "audit.invite.create": "Invitație creată",
    "audit.invite.revoke": "Invitație anulată",
    "audit.invite.accept": "Invitație acceptată",
    "audit.member.role": "Rol schimbat",
    "audit.member.remove": "Membru scos",
    "audit.runner.add": "Runner adăugat",
    "audit.runner.remove": "Runner scos",
    "audit.runner.ai-account": "Contul AI al runnerului",
    "audit.grant.use": "Pachet Enterprise deblocat",
    "audit.grant.install": "Instalare Enterprise aprobată",
    "audit.grant.revoke": "Aprobare Enterprise retrasă",
    "audit.settings.memory": "Memoria firmei",
    "audit.staff.create": "Angajat AI adăugat",
    "audit.staff.update": "Angajat AI modificat",
    "audit.staff.delete": "Angajat AI scos",
    "audit.pack.install": "Pachet instalat",
    "audit.pack.update": "Pachet actualizat",
    "audit.pack.remove": "Pachet scos",
    "nav.roles": "Roluri",
    "nav.journal": "Jurnal",
    "res.chats": "Chaturi",
    "res.memorie": "Memorie",
    "res.pachete": "Pachete",
    "res.angajati": "Angajați AI",
    "res.facturare": "Facturare",
    "res.echipa": "Echipă",
    "res.dispozitive": "Dispozitive",
    "act.vede": "Vede",
    "act.creeaza": "Creează",
    "act.aproba": "Aprobă",
    "act.trimite": "Trimite",
    "act.administreaza": "Administrează",
    "perm.chats:urmareste": "Urmărește pe server chaturile pornite de sarcinile lui",
    "perm.chats:urmareste-toate": "Urmărește toate chaturile de pe server",
    "access.denied": "Rolul tău nu permite asta",
    "access.deniedLead": "Cere unui owner sau admin al firmei să-ți schimbe rolul din Echipă, Roluri.",
    "roles.title": "Roluri și",
    "roles.titleAccent": "drepturi",
    "roles.sub": "Ce poate face fiecare om, pe tip de date și pe acțiune",
    "roles.new": "Rol nou",
    "roles.name": "Numele rolului",
    "roles.description": "Descriere (opțional)",
    "roles.save": "Salvează rolul",
    "roles.delete": "Șterge rolul",
    "roles.reset": "Înapoi la implicit",
    "roles.builtin": "rol de bază",
    "roles.custom": "rol propriu",
    "roles.people": "{n} oameni",
    "roles.person": "1 om",
    "roles.all": "Are toate drepturile. Nu se poate restrânge.",
    "roles.edit": "Schimbă",
    "roles.saved": "Rolul a fost salvat.",
    "roles.onlyManagers": "Doar owner-ii și adminii schimbă rolurile. Vezi aici ce poate face fiecare rol.",
    "roles.lead": "Owner și Admin pot tot. Membru și Invitat au drepturi implicite pe care firma le poate schimba. Un rol propriu (de exemplu Contabilitate sau Vânzări) înlocuiește drepturile lui Membru sau Invitat pentru cine îl primește; un rol pe un proiect sau o echipă se adaugă doar acolo.",
    "roles.agentsNote": "Angajații AI lucrează cu drepturile omului care le-a dat sarcina, niciodată mai mult. Fără „Angajați AI: trimite”, un agent pornit de acel om nu poate trimite e-mailuri, postări sau mesaje în afară, chiar cu aprobările oprite.",
    "roles.whoHas": "Cine are ce rol",
    "roles.base": "Rol de bază",
    "roles.customRole": "Rol propriu",
    "roles.scoped": "Pe proiecte sau echipe",
    "roles.none": "fără (drepturile rolului de bază)",
    "roles.addScoped": "Adaugă",
    "roles.scopeOn": "pe {scope}",
    "roles.fullAccess": "toate drepturile",
    "roles.scopes": "Echipe și proiecte",
    "roles.scopesLead": "Un rol poate fi dat doar pentru un proiect sau pentru o echipă (toate proiectele ei). Id-ul proiectului e cel din aplicație (Proiect, Setări).",
    "roles.newTeam": "Echipă nouă",
    "roles.addTeam": "Adaugă echipa",
    "roles.projectId": "Id proiect",
    "roles.projectName": "Nume proiect",
    "roles.projectTeam": "Echipa",
    "roles.noTeam": "fără echipă",
    "roles.addProject": "Adaugă proiectul",
    "roles.team": "echipa {name}",
    "roles.project": "proiectul {name}",
    "roles.extras": "Serverul firmei",
    "journal.title": "Jurnalul de",
    "journal.titleAccent": "securitate",
    "journal.sub": "Fiecare schimbare, intrare în cont și sarcină, legată cu hash-uri: nimic nu se poate șterge sau schimba fără să se vadă.",
    "journal.person": "Persoana",
    "journal.anyone": "oricine",
    "journal.action": "Acțiunea",
    "journal.anyAction": "orice",
    "journal.from": "De la",
    "journal.to": "Până la",
    "journal.search": "Caută",
    "journal.more": "Mai multe",
    "journal.export": "Exportă",
    "journal.when": "Când",
    "journal.who": "Cine",
    "journal.what": "Ce",
    "journal.where": "De unde",
    "journal.detail": "Detalii",
    "journal.none": "Nimic pentru filtrele alese.",
    "journal.verify": "Verifică lanțul",
    "journal.verifyLead": "Recalculează fiecare hash, de la primul eveniment, și îl compară cu ancorele zilnice păstrate separat.",
    "journal.intact": "Lanțul e întreg: {n} evenimente, ultimul hash {hash}.",
    "journal.broken": "Lanțul e rupt la evenimentul {n}: {reason}.",
    "journal.anchors": "Ancore zilnice: {n}",
    "journal.siem": "Trimite spre SIEM",
    "journal.siemLead": "Fiecare eveniment al firmei pleacă, semnat HMAC-SHA256 (antetul x-zen-signature), la adresa sistemului vostru de securitate.",
    "journal.siemUrl": "Adresa (https://)",
    "journal.siemSecret": "Secret (opțional; altfel îl generăm)",
    "journal.siemSave": "Pornește trimiterea",
    "journal.siemTest": "Trimite un test",
    "journal.siemRemove": "Oprește",
    "journal.siemSecretOnce": "Secretul, arătat o singură dată: {secret}",
    "journal.siemStatus": "Ultimul răspuns: {status} · {when}",
    "journal.siemNever": "Nimic trimis încă.",
    "journal.device": "dispozitiv",
    "team.roles": "Roluri",
    "team.customRole": "rol: {name}",
    "team.scopedRoles": "+{n} pe proiecte",
    "company.runnerMulti": "Același calculator poate fi serverul mai multor firme, cu un singur cont și un singur serviciu. Fiecare firmă își păstrează contul AI, angajații AI, memoria și criptarea; nimic nu trece de la o firmă la alta.",
    "audit.role.create": "Rol nou",
    "audit.role.update": "Rol schimbat",
    "audit.role.delete": "Rol șters",
    "audit.role.reset": "Rol readus la implicit",
    "audit.role.permissions": "Drepturile unui rol",
    "audit.member.access": "Rol propriu dat",
    "audit.member.permissions": "Drepturile unui om",
    "audit.team.create": "Echipă nouă",
    "audit.team.delete": "Echipă ștearsă",
    "audit.project.put": "Proiect pentru roluri",
    "audit.project.delete": "Proiect scos",
    "audit.auth.signin": "Intrare în cont",
    "audit.audit.export": "Jurnal exportat",
    "audit.siem.set": "SIEM pornit",
    "audit.siem.remove": "SIEM oprit",
    "audit.siem.test": "Test SIEM",
    "audit.runner.task.request": "Sarcină trimisă serverului",
    "audit.runner.task.start": "Sarcină pornită pe server",
    "audit.runner.task.finish": "Sarcină terminată pe server",
    "audit.runner.chat.start": "Chat pornit pe server",
    "audit.runner.follow": "Urmărit pe server",
    "audit.approval.decided": "Aprobare decisă",
    "audit.company.profile": "Datele firmei",
    "audit.passkey.add": "Cheie de acces adăugată",
    "audit.passkey.remove": "Cheie de acces scoasă",
    "nav.stats": "Cifre",
    "nav.admin": "Administrare",
    "stats.title": "Cifrele",
    "stats.titleAccent": "Zen Staff",
    "stats.sub": "Ultimele 30 de zile, actualizat {when}. Doar totaluri: fără adrese IP, fără identificatori, fără cookie-uri.",
    "stats.kpiDownloads": "Descărcări",
    "stats.kpiDownloadsSub": "{n} în ultimele 7 zile",
    "stats.kpiActive": "Instalări active azi",
    "stats.kpiActiveSub": "estimare; ieri {n}",
    "stats.kpiAccounts": "Conturi în hub",
    "stats.kpiVisits": "Vizite pe site",
    "stats.kpiVisitsSub": "{n} în ultimele 7 zile",
    "stats.kpiMissing": "fără date de la Cloudflare",
    "stats.downloads": "Descărcări pe zi",
    "stats.downloadsUnit": "descărcări",
    "stats.downloadsNoneT": "Încă nicio descărcare",
    "stats.downloadsNone": "Apar aici după prima descărcare de pe releases.zed-zen.com.",
    "stats.downloadsNote": "Instalatoare descărcate de pe site. Roboții și actualizările făcute din aplicație nu intră aici.",
    "stats.fmtExe": "Windows",
    "stats.fmtAppImage": "Linux AppImage",
    "stats.fmtDeb": "Linux .deb",
    "stats.total": "Total",
    "stats.countries": "Țări",
    "stats.countriesNone": "Încă nicio descărcare.",
    "stats.countryUnknown": "Necunoscută",
    "stats.active": "Instalări active pe zi",
    "stats.activeUnit": "instalări",
    "stats.activeNoneT": "Încă nicio verificare",
    "stats.activeNone": "Fiecare aplicație instalată și deschisă cere fișierul de actualizări; numărăm aceste cereri.",
    "stats.activeNote": "Estimare: o aplicație deschisă verifică actualizările la circa 4 ore, deci verificări pe zi împărțit la {n}. Aplicația nu spune versiunea când verifică.",
    "stats.osWin": "Windows",
    "stats.osLinux": "Linux",
    "stats.checksToday": "Verificări azi",
    "stats.versions": "Actualizări pe versiune",
    "stats.version": "Versiune",
    "stats.versionsNone": "Încă nicio actualizare descărcată din aplicație.",
    "stats.versionsNote": "Versiunea spre care s-au actualizat aplicațiile, în ultimele 30 de zile.",
    "stats.hub": "Hub",
    "stats.accounts": "Conturi",
    "stats.companies": "Firme",
    "stats.members": "Membri în firme",
    "stats.devices": "Dispozitive legate",
    "stats.newWeek": "+{n} în ultimele 7 zile",
    "stats.newWeekNone": "nimic nou în 7 zile",
    "stats.hubNote": "Numărate direct în baza hubului; pagina nu arată nume sau adrese.",
    "stats.landing": "Vizite pe site",
    "stats.visitsUnit": "vizite",
    "stats.visits": "Vizite",
    "stats.views": "Pagini văzute",
    "stats.landingNoneT": "Încă nicio vizită numărată",
    "stats.landingNone": "Cloudflare Web Analytics numără de pe 8 noiembrie 2026, fără cookie-uri.",
    "stats.notConfiguredT": "Lipsește legătura cu Cloudflare",
    "stats.notConfigured": "Hubul are nevoie de HUB_STATS_CF_ACCOUNT_ID și HUB_STATS_CF_TOKEN (token doar de citire, Account Analytics: Read).",
    "stats.unavailableT": "Cloudflare nu a răspuns",
    "stats.unavailable": "Încearcă din nou peste un minut.",
    "nav.short.home": "Acasă",
    "nav.short.team": "Echipă",
    "nav.short.devices": "Dispozitive",
    "nav.short.staff": "Angajați",
    "lang.label": "Limba",
    "lang.lead": "Pentru pagina asta și pentru e-mailurile de la Zen Staff.",
    "ph.email": "nume@firma.example",
    "ph.colleague": "coleg@firma.example",
    "ph.company": "Casa Verde SRL",
    "ph.team": "Vânzări",
    "ph.projectId": "site-firma",
    "ph.projectName": "Site-ul firmei",
    "ph.siem": "https://siem.firma.ro/zen",
    "ph.authorCompany": "Bistro Ana",
  },
  en: {
    "nav.home": "Home",
    "nav.company": "Company",
    "nav.team": "Team",
    "nav.devices": "Devices",
    "nav.staff": "AI staff",
    "nav.packs": "Company packs",
    "nav.security": "Security",
    "nav.plan": "Plan",
    "nav.library": "Library",
    "nav.review": "Review",
    "nav.more": "More",
    "nav.menu": "Menu",
    "nav.collapse": "Collapse the sidebar",
    "nav.expand": "Expand the sidebar",
    "nav.logout": "Sign out",
    "nav.pages": "Pages",
    "nav.switch": "Switch company",
    "nav.newCompany": "Create a company",
    "nav.account": "Your account",
    "role.owner": "Owner",
    "role.admin": "Admin",
    "role.member": "Member",
    "role.guest": "Guest",
    "plan.hosted": "Hosted",
    "plan.selfhost": "Self-host",
    "plan.trial": "Trial",
    "plan.free": "Free",
    "common.save": "Save",
    "common.saved": "Saved.",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.online": "Online",
    "common.offline": "Offline",
    "common.never": "never",
    "common.sure": "Sure?",
    "common.remove": "Remove",
    "common.retry": "Try again",
    "common.loadFailed": "Could not load the data from the hub.",
    "fatal.title": "The hub is not",
    "fatal.accent": "answering",
    "common.seeAll": "See all",
    "common.now": "just now",
    "common.minAgo": "{n} min ago",
    "common.hAgo": "{n} h ago",
    "common.today": "today",
    "common.download": "Download Zen Staff",
    "common.yes": "yes",
    "common.no": "no",
    "login.title": "Sign in to",
    "login.titleAccent": "your account",
    "login.lead": "Your Zen Staff team account: the company, your colleagues, your devices and the AI staff.",
    "login.email": "E-mail address",
    "login.send": "Send the code",
    "login.or": "or",
    "login.passkey": "Sign in with a passkey",
    "login.passkeyNo": "This browser does not support passkeys.",
    "login.passkeyCancelled": "Cancelled or expired. Try again.",
    "login.passkeyRefused": "The passkey was not accepted. It may have been removed; sign in with the e-mail code.",
    "login.codeTitle": "Check",
    "login.codeAccent": "your e-mail",
    "login.codeLead": "We sent a 6-digit code to {email}. Type it here, or open the link in the e-mail on any device.",
    "login.code": "Code from the e-mail",
    "login.enter": "Sign in",
    "login.other": "Use another address",
    "login.waitingLink": "We are also waiting for the e-mail link; this page continues by itself when you open it.",
    "login.note": "No password: you get a code by e-mail or use a passkey (fingerprint, face, PIN).",
    "login.landing": "About Zen Staff",
    "login.quote1": "Nothing goes out without",
    "login.quoteAccent": "approval",
    "login.quote2": "from the boss.",
    "login.glimpseWho": "Ana",
    "login.glimpseRole": "Accounting",
    "login.glimpseChip": "Asks for approval",
    "login.glimpseTitle": "Send invoices-october-2026.xlsx to the accountant",
    "login.glimpseMeta": "Approved by Andrei, 2 min ago",
    "twofa.verifyTitle": "Second",
    "twofa.verifyAccent": "step",
    "twofa.verifyLead": "Your account has two-factor authentication on. Type the 6-digit code from your authenticator app.",
    "twofa.code": "6-digit code",
    "twofa.useRecovery": "Use a recovery code",
    "twofa.useCode": "Use the code from the app",
    "twofa.recovery": "Recovery code",
    "twofa.check": "Verify",
    "twofa.setupTitle": "Turn on",
    "twofa.setupAccent": "two-factor",
    "twofa.setupLead": "As an owner or admin of a company, you sign in with a second step: a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden).",
    "twofa.scan": "Scan the QR code with the app, then type the code it shows you.",
    "twofa.manual": "Cannot scan? Add the key by hand:",
    "twofa.enable": "Turn on",
    "twofa.codesTitle": "Your recovery",
    "twofa.codesAccent": "codes",
    "twofa.codesLead": "If you lose your phone, you sign in with one of these codes. Each works once. Keep them in a password manager or on paper, not on the same phone.",
    "twofa.codesDone": "I saved the codes, continue",
    "twofa.copyCodes": "Copy the codes",
    "home.morning": "Good morning,",
    "home.day": "Good afternoon,",
    "home.evening": "Good evening,",
    "home.invite": "Invite a colleague",
    "home.kpiTasks": "AI tasks, 7 days",
    "home.kpiTasksSub": "{d} vs last week",
    "home.kpiTasksSame": "same as last week",
    "home.kpiMembers": "People in the company",
    "home.kpiMembersSub": "+{n} in the last 30 days",
    "home.kpiDevices": "Devices online",
    "home.kpiDevicesNone": "no computer yet",
    "home.kpiApprovals": "To approve",
    "home.kpiApprovalsNone": "everything is signed",
    "home.kpiApprovalsSome": "waiting for your signature",
    "home.kpiGuest": "members only",
    "home.approvals": "To approve",
    "home.waiting": "{n} waiting",
    "home.approvalsEmpty": "Nothing to approve. When a colleague signs in on a new computer or hands a conversation over to you, it shows up here.",
    "home.approvalsNote": "Approvals for the AI staff's work (e-mails, documents, payments) are in the app: their content is end-to-end encrypted and the hub cannot see it.",
    "home.apDevice": "New device",
    "home.apDeviceTitle": "{device}, reported by the runner \"{runner}\"",
    "home.apDeviceHow": "Check the fingerprint with {name}, then approve in the app or on the runner.",
    "home.apDeviceHowMine": "This is your new computer. Approve it in the app, on a computer that is already approved, or ask whoever runs the runner.",
    "home.apHandover": "Handover",
    "home.apHandoverTitle": "{name} is handing a conversation over to you",
    "home.apHandoverHow": "Take it or decline it in the app, under Team > Received.",
    "home.apInvite": "Invitation",
    "home.apInviteTitle": "Join {company} as {role}",
    "home.apInvitesSent": "Invitations sent",
    "home.apInvitesSentTitle": "{n} colleagues have not accepted yet",
    "home.apInvitesSentOne": "One colleague has not accepted yet",
    "home.apInvitesSentHow": "You can send them the link again or cancel the invitations.",
    "home.stampWaiting": "Waiting",
    "home.stampApproved": "Approved",
    "home.openTeam": "See the team",
    "home.activity": "AI staff activity",
    "home.days7": "7 days",
    "home.days30": "30 days",
    "home.tasks": "tasks through the hub",
    "home.tasksDay": "{n} tasks",
    "home.changes": "profile changes",
    "home.shares": "shared conversations",
    "home.comments": "comments",
    "home.activityNote": "The hub sees only metadata: how many, when and who. What the AI staff write stays encrypted between the apps and the runner.",
    "home.activityEmptyT": "No tasks through the hub yet",
    "home.activityEmpty": "Give an AI staff member their first task from the app, in the company chat: @ and their name. Here you see how many you sent each day.",
    "home.activityGuest": "Guests do not see the AI staff activity.",
    "home.runner": "Company runner",
    "home.runnerOn": "Online, taking tasks",
    "home.runnerOff": "Offline, seen {when}",
    "home.runnerOwner": "Computer of",
    "home.runnerAccount": "AI account",
    "home.runnerStaff": "AI staff hosted",
    "home.runnerNoneT": "The company has no runner yet",
    "home.runnerStep1": "Install Zen Staff on the computer that stays on at the office.",
    "home.runnerStep2": "Sign in with your account, on this hub.",
    "home.runnerStep3": "Team > Companies > Make it the company runner.",
    "home.timeline": "What happened",
    "home.timelineEmptyT": "Nothing in the log yet",
    "home.timelineEmpty": "The log is empty. Invitations, roles, runners and packs show up here as they change.",
    "home.timelineMine": "The company log is for owners and admins; here are your account's events.",
    "home.packs": "Company packs",
    "home.packsEmptyT": "No packs for the whole company",
    "home.packsEmpty": "An admin installs packs for everyone from the app: Store > Install for the company.",
    "home.packHealth": "{ok} of {n} computers",
    "home.packNoStatus": "no computer has reported yet",
    "home.packOk": "Working",
    "home.packBad": "Error",
    "home.packWait": "Installing",
    "home.team": "Team",
    "home.teamEmptyT": "You are alone in the company",
    "home.teamEmpty": "Invite your colleagues: they get an e-mail or a link and sign in with their own address. Each seat starts on the trial.",
    "home.staff": "AI staff",
    "home.staffEmptyT": "The company has no AI staff",
    "home.staffEmpty": "Create them in the app, under Staff > New > For the whole company. Here you see who they are and which runner hosts them.",
    "home.staffBy": "manager {name}",
    "home.myDevices": "Your computers",
    "home.myDevicesEmptyT": "No computer connected",
    "home.myDevicesEmpty": "Install Zen Staff and sign in with the same account; the computer shows up here.",
    "home.lastSeen": "seen {when}",
    "home.neverSeen": "not connected yet",
    "home.noCompany": "Welcome to",
    "home.noCompanyAccent": "Zen Staff",
    "home.noCompanyLead": "Create your company or accept an invitation from a colleague.",
    "company.title": "Company",
    "company.titleAccent": "details",
    "company.name": "Company name",
    "company.rename": "Rename",
    "company.identity": "Company",
    "company.since": "{n} people · {role}",
    "company.details": "Billing details",
    "company.detailsLead": "We use them for invoices once payments start. The whole team sees them; only owners and admins change them.",
    "company.legalName": "Legal name",
    "company.taxId": "Tax ID (CUI)",
    "company.registryNo": "Trade register no.",
    "company.address": "Address",
    "company.city": "City",
    "company.county": "County or region",
    "company.country": "Country",
    "company.billingEmail": "E-mail for invoices",
    "company.create": "Create a company",
    "company.createLead": "You become the owner. Then you invite your colleagues and choose the computer that hosts the company's AI staff.",
    "company.createButton": "Create the company",
    "company.createAnother": "Another company",
    "company.createAnotherLead": "Working for several companies? Each one has its own team, runner and AI staff.",
    "company.readOnly": "Only owners and admins change the company details.",
    "company.filled": "{n} of 8 filled in",
    "team.title": "People in the",
    "team.titleAccent": "company",
    "team.members": "Members",
    "team.you": "you",
    "team.leave": "Leave the company",
    "team.since": "since {date}",
    "team.twofaOn": "two-factor on",
    "team.twofaOff": "no two-factor",
    "team.invite": "Invite a colleague",
    "team.inviteEmail": "By e-mail",
    "team.inviteEmailLead": "They get an e-mail with the invitation and accept it by signing in with this address.",
    "team.inviteSend": "Send the invitation",
    "team.inviteSent": "The invitation went to {email}.",
    "team.inviteLink": "By link",
    "team.inviteLinkLead": "A link you send yourself, on any channel. It works once, for 14 days.",
    "team.inviteLinkMake": "Create the link",
    "team.inviteLinkOnce": "Copy it now: for security, the hub cannot show it again.",
    "team.email": "E-mail",
    "team.role": "Role",
    "team.pending": "Pending invitations",
    "team.pendingNone": "No pending invitations. The ones you send show up here until someone accepts them.",
    "team.pendingLink": "invitation link",
    "team.revoke": "Cancel",
    "team.roleHelp": "Owner: everything, other owners included. Admin: the team, the runner, the packs. Member: works with the AI staff. Guest: sees only what is shared with them.",
    "team.inviteOnlyManagers": "Owners and admins invite colleagues. Ask one of them to send the link to your colleague.",
    "devices.title": "Computers and",
    "devices.titleAccent": "keys",
    "devices.machines": "Your computers",
    "devices.runnerFor": "runner of {company}",
    "devices.keys": "Your device keys",
    "devices.keysLead": "Each app you sign in to has its own key. The company runners accept requests only from keys they know.",
    "devices.keyApproved": "approved by another device",
    "devices.keyFirst": "first key, or approved on the runner",
    "devices.keyRevoked": "{n} old keys removed",
    "devices.keysNone": "No key yet: one appears when you sign in to the Zen Staff app.",
    "devices.approveHow": "How to approve a new device",
    "devices.approveText": "An approval is a signature made with the key of a device that is already approved, so the hub cannot fake it. The browser has no such key, so you approve in the app: on an approved device, Team > Account > Keys > Approve; or on the runner, Team > Account > Waiting for approval. Here you check the fingerprint and end any session you do not recognise.",
    "devices.waiting": "Devices waiting for approval",
    "devices.waitingNone": "No new device reported in the last 14 days.",
    "devices.waitingNote": "The runner does not tell the hub when it approves, so a request here may already be settled on the runner.",
    "devices.sessions": "Open sessions",
    "devices.sessionCurrent": "this session",
    "devices.sessionEnd": "End",
    "devices.sessionUsed": "used {when}",
    "devices.method.email": "e-mail code",
    "devices.method.passkey": "passkey",
    "devices.method.google": "Google",
    "devices.method.microsoft": "Microsoft",
    "devices.with2fa": "with two-factor",
    "staff.title": "AI",
    "staff.titleAccent": "staff",
    "staff.lead": "The company's AI staff, synced through the hub.",
    "staff.count": "{n} AI staff in the company",
    "staff.lastChange": "last change {when}",
    "staff.sealedT": "The profiles are sealed",
    "staff.sealed": "The name, role, instructions and rules of each AI staff member are encrypted for the company runners. The hub, and so this page, sees only the ID, version, manager and when it changed. You create and edit them in the app, under Staff.",
    "staff.manager": "Manager",
    "staff.noManager": "no manager",
    "staff.runsOn": "Runs on",
    "staff.updated": "changed {when}",
    "staff.updatedBy": "changed {when} by {name}",
    "staff.none": "The company has no AI staff for the whole team yet. Add them from the app: Staff > New > For the whole company.",
    "staff.guest": "Guests do not see the company's AI staff.",
    "packs.title": "Company",
    "packs.titleAccent": "packs",
    "packs.lead": "The packs installed for the whole company and how they are doing on each computer.",
    "packs.how": "You install, update and remove packs for the whole company from the app: the request is signed with an admin's device key.",
    "packs.by": "installed by {name}, {date}",
    "packs.enterprise": "Enterprise, runner only",
    "packs.none": "No packs installed for the whole company. An admin installs them from the app: Store > Install for the company.",
    "packs.statusNone": "No computer has reported its status yet.",
    "packs.state.installing": "Installing",
    "packs.state.installed": "Installed",
    "packs.state.failed": "Error",
    "packs.state.runner-only": "Runner only",
    "packs.mineOnly": "You see only your computers; admins see the whole company.",
    "security.title": "Account and",
    "security.titleAccent": "security",
    "security.account": "Your account",
    "security.yourName": "Your name",
    "security.twofa": "Two-factor authentication",
    "security.twofaOn": "On",
    "security.twofaOff": "Off",
    "security.twofaRequired": "Required for owners and admins.",
    "security.twofaOptional": "Optional for you; we recommend it.",
    "security.codesLeft": "{n} recovery codes left",
    "security.newCodes": "Generate new codes",
    "security.newCodesLead": "The old codes stop working. Confirm with a code from the app.",
    "security.disable": "Turn off",
    "security.disableLead": "Confirm with a code from the app.",
    "security.passkeys": "Passkeys",
    "security.passkeysLead": "Sign in with your device's fingerprint, face or PIN, without an e-mail code. It counts as two-factor.",
    "security.passkeysNone": "No passkey yet. Add one on the computer you use every day.",
    "security.passkeyAdd": "Add a passkey",
    "security.passkeyName": "Name (e.g. Office laptop)",
    "security.passkeyOpened": "We opened the passkey page in a new tab. Come back here when you are done.",
    "security.passkeyLastUsed": "used {when}",
    "security.passkeySynced": "synced",
    "security.audit": "Security log",
    "security.auditNone": "Nothing in the log yet.",
    "security.auditWhen": "When",
    "security.auditWho": "Who",
    "security.auditWhat": "What",
    "security.auditDetail": "Details",
    "plan.title": "Company",
    "plan.titleAccent": "plan",
    "plan.yours": "Company plan",
    "plan.seatsCost": "Seats and cost",
    "plan.seats": "Seats taken",
    "plan.seatsLead": "Owners, admins and members take a seat; guests do not.",
    "plan.guests": "Guests, free",
    "plan.monthly": "After the trial, per month",
    "plan.after": "After the trial: {total} € / month for {n} seats.",
    "plan.trialLead": "Payments are not on yet. During the trial you pay nothing and we do not ask for your card.",
    "plan.selfhostLead": "This hub is hosted by your company. Self-host is free.",
    "plan.invoices": "Invoices",
    "plan.invoicesNoneT": "No invoices yet",
    "plan.invoicesNone": "They will show up here, with the details from Company. Check now that they are right.",
    "plan.checkDetails": "Billing details",
    "plan.personal": "Personal",
    "plan.personalFor": "for anyone, on any computer",
    "plan.personal1": "Unlimited agents, with your own AI account",
    "plan.personal2": "The work packs from the store",
    "plan.personal3": "Windows, macOS, Linux, Android",
    "plan.personalNote": "No hub: no team chats, shared memory or approvals.",
    "plan.selfhostFor": "for your company, on your server",
    "plan.selfhost1": "The full hub, on your server",
    "plan.selfhost2": "Team chats, shared memory, approvals",
    "plan.selfhost3": "The company's AI staff, unlimited agents",
    "plan.selfhostNote": "Free for your company; you may not resell it as a hosted service.",
    "plan.hostedName": "Team",
    "plan.hostedFor": "/ user / month",
    "plan.hosted1": "The hub and the company memory, hosted by us",
    "plan.hosted2": "Updates, backups and support included",
    "plan.hosted3": "Unlimited agents; you pay only for people",
    "plan.hostedNote": "The agents still run at your place, on the company's computers.",
    "plan.current": "company plan",
    "plan.status.none": "not active",
    "plan.status.trialing": "trial",
    "plan.status.active": "active",
    "plan.status.past_due": "payment overdue",
    "plan.status.unpaid": "unpaid",
    "plan.status.canceled": "cancelled",
    "plan.status.paused": "paused",
    "plan.status.incomplete": "payment in progress",
    "plan.status.incomplete_expired": "not active",
    "plan.sub": "Subscription",
    "plan.subLead": "You pay only for people: owners, admins and members. Guests and agents are free.",
    "plan.seatsN": "Paid seats",
    "plan.servers": "Always-on servers",
    "plan.nextInvoice": "Next invoice, estimated",
    "plan.renews": "Renews on {date}.",
    "plan.endsAt": "Ends on {date}; it will not renew.",
    "plan.trialLeft": "{n} trial days left, until {date}. The first payment comes after that, from the saved card or account.",
    "plan.trialLeft1": "Last trial day: {date}.",
    "plan.upgrade": "Switch to Hosted",
    "plan.upgradeTrial": "Start the {n}-day trial",
    "plan.upgradeLead": "{n} seats x {price} € per month. Pay by card or SEPA direct debit, on Stripe's secure page.",
    "plan.manage": "Manage payment",
    "plan.manageLead": "Card, address, Stripe invoices and cancellation, in the Stripe portal.",
    "plan.downloadInvoices": "Invoices",
    "plan.notEnabled": "Payments are not on yet on this hub. Until then the trial goes on and we do not ask for your card.",
    "plan.testMode": "Stripe test mode: no payment is real.",
    "plan.membersOnly": "Only owners and admins change the plan and payments.",
    "plan.addonT": "Always-on server",
    "plan.addonPrice": "{price} € / month / server",
    "plan.addonLead": "A server that is always on for the company's AI staff: they work on schedules and triggers even when your computers are off. It connects to the hub by itself.",
    "plan.addonSave": "Update",
    "plan.addonAfter": "Add it after you start the subscription; the difference is prorated by day.",
    "plan.addonAtCheckout": "Servers to include from day one",
    "plan.packagesT": "Done for you",
    "plan.packagesLead": "The ZED-ZEN team installs, connects and trains. One payment, no subscription.",
    "plan.packageUnit": "one-time",
    "plan.buy": "Buy {name}",
    "plan.packagePaid": "paid",
    "plan.invoicesLead": "The tax invoice is issued by FORTITUDO VINCIT S.R.L. and filed in e-Factura (SPV), Romania's e-invoicing system. The Stripe receipt shows the card payment.",
    "plan.colDate": "Date",
    "plan.colPeriod": "Period",
    "plan.colAmount": "Amount",
    "plan.colFiscal": "Tax invoice",
    "plan.colEfactura": "e-Factura",
    "plan.fiscalPending": "in progress",
    "plan.fiscalFailed": "to redo",
    "plan.fiscalDryRun": "dry run",
    "plan.ef.accepted": "accepted",
    "plan.ef.rejected": "rejected",
    "plan.ef.pending": "sending",
    "plan.ef.uploaded": "uploaded",
    "plan.ef.in_processing": "processing",
    "plan.pdf": "PDF",
    "plan.receipt": "Receipt",
    "plan.packageKind": "Done for you",
    "plan.subscriptionKind": "Subscription",
    "plan.billingT": "Billing details",
    "plan.billingLead": "They appear on the tax invoice. Romanian companies must give their CUI, which we check by its control digit; for EU companies we check the VAT number in VIES.",
    "plan.country": "Country (code, e.g. RO)",
    "plan.vies.valid": "VAT number valid in VIES.",
    "plan.vies.invalid": "VIES does not find this VAT number; the invoice will include VAT, without reverse charge.",
    "plan.vies.unavailable": "VIES is not answering right now; we check again at payment.",
    "plan.vat.not_registered": "No VAT: FORTITUDO VINCIT S.R.L. is not registered for VAT.",
    "plan.vat.standard": "VAT {rate}% included in the invoice.",
    "plan.vat.reverse_charge": "Reverse charge: you declare the VAT.",
    "plan.vat.outside_scope": "No VAT: customer outside the EU.",
    "plan.missing": "Fill in the billing details before paying.",
    "plan.paidOk": "Thank you! Stripe confirms the payment; the plan updates in a few seconds.",
    "plan.paidPackage": "Thank you! The package is paid; we will contact you within one working day.",
    "plan.paidCancel": "The payment was cancelled. Nothing was charged.",
    "plan.banner.payment_failed": "The Hosted payment did not go through. Update your card by {date}; after that the team features become read-only.",
    "plan.banner.grace_over": "The Hosted payment is overdue, so the team features are read-only. Nothing was deleted; pay from Plan to get them back.",
    "plan.banner.unpaid": "The subscription is unpaid: the team features are read-only. Nothing was deleted.",
    "plan.banner.canceled": "The Hosted subscription is cancelled: the team features are read-only. The data stays; you can start it again from Plan.",
    "plan.banner.paused": "The subscription is paused: the team features are read-only.",
    "plan.banner.pending": "Waiting for the first payment to be confirmed (SEPA debit can take a few days).",
    "plan.bannerGo": "Go to Plan",
    "err.code.billing_read_only": "The company plan is not paid, so the team features are read-only. An owner or admin can pay from Plan.",
    "err.code.billing_not_configured": "Payments are not on yet on this hub.",
    "err.code.billing_details_missing": "Fill in the billing details first.",
    "err.code.invalid_cui": "The CUI is not valid (the control digit does not match).",
    "err.code.invalid_vat": "The VAT number does not have the right format for the chosen country.",
    "err.code.already_subscribed": "The company is already on the Hosted plan. Manage it in the payment portal.",
    "err.code.no_subscription": "Start the subscription first.",
    "invite.title": "An",
    "invite.titleAccent": "invitation",
    "invite.lead": "You got an invitation link to a company on Zen Staff.",
    "invite.accept": "Accept the invitation",
    "invite.paste": "Invitation link",
    "invite.accepted": "You joined {company}.",
    "invite.mine": "Invitations for {email}",
    "invite.mineNone": "No invitations for your address. If a colleague invited you at another address, sign in with that one.",
    "err.wrongCode": "The code is wrong or expired.",
    "err.wrongTotp": "The code is wrong or was already used.",
    "err.limited": "Too many attempts. Wait a few minutes.",
    "err.email": "Enter a valid e-mail address.",
    "err.forbidden": "You are not allowed to do this.",
    "err.inviteInvalid": "The invitation is no longer valid.",
    "err.inviteOther": "The invitation is for another address. Sign in with the address it was sent to.",
    "err.generic": "That did not work. Try again.",
    "err.offline": "Cannot reach the hub. Check your internet connection.",
    "audit.invite.create": "Invitation created",
    "audit.invite.revoke": "Invitation cancelled",
    "audit.invite.accept": "Invitation accepted",
    "audit.member.role": "Role changed",
    "audit.member.remove": "Member removed",
    "audit.runner.add": "Runner added",
    "audit.runner.remove": "Runner removed",
    "audit.runner.ai-account": "Runner's AI account",
    "audit.grant.use": "Enterprise pack unlocked",
    "audit.grant.install": "Enterprise install approved",
    "audit.grant.revoke": "Enterprise approval withdrawn",
    "audit.settings.memory": "Company memory",
    "audit.staff.create": "AI staff member added",
    "audit.staff.update": "AI staff member changed",
    "audit.staff.delete": "AI staff member removed",
    "audit.pack.install": "Pack installed",
    "audit.pack.update": "Pack updated",
    "audit.pack.remove": "Pack removed",
    "nav.roles": "Roles",
    "nav.journal": "Log",
    "res.chats": "Chats",
    "res.memorie": "Memory",
    "res.pachete": "Packs",
    "res.angajati": "AI staff",
    "res.facturare": "Billing",
    "res.echipa": "Team",
    "res.dispozitive": "Devices",
    "act.vede": "View",
    "act.creeaza": "Create",
    "act.aproba": "Approve",
    "act.trimite": "Send",
    "act.administreaza": "Manage",
    "perm.chats:urmareste": "Follow on the server the chats started by their own tasks",
    "perm.chats:urmareste-toate": "Follow all chats on the server",
    "access.denied": "Your role does not allow this",
    "access.deniedLead": "Ask an owner or admin of the company to change your role in Team, Roles.",
    "roles.title": "Roles and",
    "roles.titleAccent": "permissions",
    "roles.sub": "What each person can do, by type of data and by action",
    "roles.new": "New role",
    "roles.name": "Role name",
    "roles.description": "Description (optional)",
    "roles.save": "Save the role",
    "roles.delete": "Delete the role",
    "roles.reset": "Back to default",
    "roles.builtin": "built-in role",
    "roles.custom": "custom role",
    "roles.people": "{n} people",
    "roles.person": "1 person",
    "roles.all": "Has every permission. It cannot be restricted.",
    "roles.edit": "Change",
    "roles.saved": "The role was saved.",
    "roles.onlyManagers": "Only owners and admins change roles. Here you see what each role can do.",
    "roles.lead": "Owner and Admin can do everything. Member and Guest have default permissions the company can change. A custom role (for example Accounting or Sales) replaces the Member or Guest permissions for whoever gets it; a role on a project or a team applies only there.",
    "roles.agentsNote": "AI staff work with the permissions of the person who gave them the task, never more. Without \"AI staff: Send\", an agent started by that person cannot send e-mails, posts or messages outside, even with approvals turned off.",
    "roles.whoHas": "Who has which role",
    "roles.base": "Base role",
    "roles.customRole": "Custom role",
    "roles.scoped": "On projects or teams",
    "roles.none": "none (the base role's permissions)",
    "roles.addScoped": "Add",
    "roles.scopeOn": "on {scope}",
    "roles.fullAccess": "every permission",
    "roles.scopes": "Teams and projects",
    "roles.scopesLead": "A role can be given for one project only, or for a team (all its projects). The project ID is the one in the app (Project, Settings).",
    "roles.newTeam": "New team",
    "roles.addTeam": "Add the team",
    "roles.projectId": "Project ID",
    "roles.projectName": "Project name",
    "roles.projectTeam": "Team",
    "roles.noTeam": "no team",
    "roles.addProject": "Add the project",
    "roles.team": "team {name}",
    "roles.project": "project {name}",
    "roles.extras": "Company server",
    "journal.title": "Security",
    "journal.titleAccent": "log",
    "journal.sub": "Every change, sign-in and task, chained with hashes: nothing can be deleted or changed without it showing.",
    "journal.person": "Person",
    "journal.anyone": "anyone",
    "journal.action": "Action",
    "journal.anyAction": "any",
    "journal.from": "From",
    "journal.to": "To",
    "journal.search": "Search",
    "journal.more": "More",
    "journal.export": "Export",
    "journal.when": "When",
    "journal.who": "Who",
    "journal.what": "What",
    "journal.where": "From where",
    "journal.detail": "Details",
    "journal.none": "Nothing for the chosen filters.",
    "journal.verify": "Verify the chain",
    "journal.verifyLead": "Recomputes every hash, from the first event, and compares it with the daily anchors kept separately.",
    "journal.intact": "The chain is intact: {n} events, last hash {hash}.",
    "journal.broken": "The chain is broken at event {n}: {reason}.",
    "journal.anchors": "Daily anchors: {n}",
    "journal.siem": "Send to a SIEM",
    "journal.siemLead": "Every company event goes out, signed with HMAC-SHA256 (the x-zen-signature header), to your security system's address.",
    "journal.siemUrl": "Address (https://)",
    "journal.siemSecret": "Secret (optional; otherwise we generate one)",
    "journal.siemSave": "Start sending",
    "journal.siemTest": "Send a test",
    "journal.siemRemove": "Stop",
    "journal.siemSecretOnce": "The secret, shown only once: {secret}",
    "journal.siemStatus": "Last answer: {status} · {when}",
    "journal.siemNever": "Nothing sent yet.",
    "journal.device": "device",
    "team.roles": "Roles",
    "team.customRole": "role: {name}",
    "team.scopedRoles": "+{n} on projects",
    "company.runnerMulti": "The same computer can be the server of several companies, with one account and one service. Each company keeps its own AI account, AI staff, memory and encryption; nothing passes from one company to another.",
    "audit.role.create": "New role",
    "audit.role.update": "Role changed",
    "audit.role.delete": "Role deleted",
    "audit.role.reset": "Role reset to default",
    "audit.role.permissions": "A role's permissions",
    "audit.member.access": "Custom role given",
    "audit.member.permissions": "A person's permissions",
    "audit.team.create": "New team",
    "audit.team.delete": "Team deleted",
    "audit.project.put": "Project for roles",
    "audit.project.delete": "Project removed",
    "audit.auth.signin": "Sign-in",
    "audit.audit.export": "Log exported",
    "audit.siem.set": "SIEM on",
    "audit.siem.remove": "SIEM off",
    "audit.siem.test": "SIEM test",
    "audit.runner.task.request": "Task sent to the server",
    "audit.runner.task.start": "Task started on the server",
    "audit.runner.task.finish": "Task finished on the server",
    "audit.runner.chat.start": "Chat started on the server",
    "audit.runner.follow": "Followed on the server",
    "audit.approval.decided": "Approval decided",
    "audit.company.profile": "Company details",
    "audit.passkey.add": "Passkey added",
    "audit.passkey.remove": "Passkey removed",
    "nav.stats": "Stats",
    "nav.admin": "Admin",
    "stats.title": "Zen Staff",
    "stats.titleAccent": "in numbers",
    "stats.sub": "The last 30 days, updated {when}. Totals only: no IP addresses, no identifiers, no cookies.",
    "stats.kpiDownloads": "Downloads",
    "stats.kpiDownloadsSub": "{n} in the last 7 days",
    "stats.kpiActive": "Active installs today",
    "stats.kpiActiveSub": "estimate; yesterday {n}",
    "stats.kpiAccounts": "Accounts on the hub",
    "stats.kpiVisits": "Site visits",
    "stats.kpiVisitsSub": "{n} in the last 7 days",
    "stats.kpiMissing": "no data from Cloudflare",
    "stats.downloads": "Downloads per day",
    "stats.downloadsUnit": "downloads",
    "stats.downloadsNoneT": "No downloads yet",
    "stats.downloadsNone": "They show up here after the first download from releases.zed-zen.com.",
    "stats.downloadsNote": "Installers downloaded from the site. Bots and updates made from the app are not counted here.",
    "stats.fmtExe": "Windows",
    "stats.fmtAppImage": "Linux AppImage",
    "stats.fmtDeb": "Linux .deb",
    "stats.total": "Total",
    "stats.countries": "Countries",
    "stats.countriesNone": "No downloads yet.",
    "stats.countryUnknown": "Unknown",
    "stats.active": "Active installs per day",
    "stats.activeUnit": "installs",
    "stats.activeNoneT": "No checks yet",
    "stats.activeNone": "Each installed and open app asks for the updates file; we count these requests.",
    "stats.activeNote": "Estimate: an open app checks for updates about every 4 hours, so checks per day divided by {n}. The app does not send its version when it checks.",
    "stats.osWin": "Windows",
    "stats.osLinux": "Linux",
    "stats.checksToday": "Checks today",
    "stats.versions": "Updates by version",
    "stats.version": "Version",
    "stats.versionsNone": "No updates downloaded from the app yet.",
    "stats.versionsNote": "The version the apps updated to, in the last 30 days.",
    "stats.hub": "Hub",
    "stats.accounts": "Accounts",
    "stats.companies": "Companies",
    "stats.members": "Company members",
    "stats.devices": "Linked devices",
    "stats.newWeek": "+{n} in the last 7 days",
    "stats.newWeekNone": "nothing new in 7 days",
    "stats.hubNote": "Counted directly in the hub's database; the page shows no names or addresses.",
    "stats.landing": "Site visits",
    "stats.visitsUnit": "visits",
    "stats.visits": "Visits",
    "stats.views": "Page views",
    "stats.landingNoneT": "No visits counted yet",
    "stats.landingNone": "Cloudflare Web Analytics has been counting since 8 November 2026, without cookies.",
    "stats.notConfiguredT": "The Cloudflare link is missing",
    "stats.notConfigured": "The hub needs HUB_STATS_CF_ACCOUNT_ID and HUB_STATS_CF_TOKEN (a read-only token, Account Analytics: Read).",
    "stats.unavailableT": "Cloudflare did not answer",
    "stats.unavailable": "Try again in a minute.",
    "nav.short.home": "Home",
    "nav.short.team": "Team",
    "nav.short.devices": "Devices",
    "nav.short.staff": "Staff",
    "lang.label": "Language",
    "lang.lead": "For this page and for the e-mails from Zen Staff.",
    "ph.email": "name@company.example",
    "ph.colleague": "colleague@company.example",
    "ph.company": "Green House Ltd",
    "ph.team": "Sales",
    "ph.projectId": "company-site",
    "ph.projectName": "Company website",
    "ph.siem": "https://siem.example.com/zen",
    "ph.authorCompany": "Ana's Bistro",
  },
};

// The language: ?lang=en|ro (kept for next time) > the choice saved in this browser > the account's
// language (loadMe, after sign-in) > the browser's first language (ro* is Romanian, the rest English).
const LANGS = ["ro", "en"];
/** Each language in its own words, for the switch. */
const LANG_NAMES = { ro: "Română", en: "English" };

function pickLanguage() {
  const url = new URL(location.href);
  const asked = url.searchParams.get("lang");
  if (LANGS.includes(asked)) {
    store("zen.lang", asked);
    url.searchParams.delete("lang");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return asked;
  }
  const saved = stored("zen.lang");
  if (LANGS.includes(saved)) return saved;
  const first = String((navigator.languages ?? [])[0] ?? navigator.language ?? "").toLowerCase();
  return first.startsWith("ro") ? "ro" : "en";
}

let LANG = pickLanguage();
document.documentElement.lang = LANG;
/** The locale for dates and numbers. */
const locale = () => (LANG === "ro" ? "ro-RO" : "en-GB");

function useLanguage(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return;
  LANG = lang;
  document.documentElement.lang = lang;
}

/** The switch: saved in this browser and on the account (its e-mails follow it), then the page reloads. */
async function setLanguage(lang) {
  store("zen.lang", lang);
  if (state.me !== null) await api("PUT", "/v1/me/preferences", { language: lang }).catch(() => undefined);
  location.reload();
}

/** RO | EN, in the dashboard's segmented style. */
function langSwitch() {
  return h(
    "div",
    { class: "seg lang-switch", role: "group", "aria-label": t("lang.label") },
    LANGS.map((lang) =>
      h("button", { type: "button", lang, title: LANG_NAMES[lang], "aria-label": LANG_NAMES[lang], "aria-pressed": String(lang === LANG), text: lang.toUpperCase(), onclick: () => setLanguage(lang) }),
    ),
  );
}

function t(key, vars = {}) {
  const text = DICT[LANG][key] ?? DICT.ro[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

// The hub answers in English; the messages people meet most often, in the page's language.
const HUB_MESSAGES = {
  "That code is wrong or expired.": "err.wrongCode",
  "That code is wrong or was already used.": "err.wrongTotp",
  "That code is wrong. Check the time on your phone and try again.": "err.wrongTotp",
  "Enter a valid e-mail address.": "err.email",
  "You do not have access to this.": "err.forbidden",
  "You cannot give that role.": "err.forbidden",
  "You cannot remove this member.": "err.forbidden",
  "You cannot invite with that role.": "err.forbidden",
  "This invitation is not valid any more.": "err.inviteInvalid",
};

const LANDING = "https://zenstaff.app";

// ---- DOM helpers -----------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    // CSSOM, not the style attribute: the page's CSP has no 'unsafe-inline' for styles.
    else if (key === "style") el.style.cssText = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** An SVG element; attributes only (no style attribute). */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  for (const child of children.flat(Infinity)) if (child) el.append(child);
  return el;
}

// Lucide icons (ISC), 2 px line, drawn as SVG elements.
const ICONS = {
  home: [["path", { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" }], ["path", { d: "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
  company: [["path", { d: "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" }], ["path", { d: "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" }], ["path", { d: "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" }], ["path", { d: "M10 6h4M10 10h4M10 14h4M10 18h4" }]],
  team: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }], ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]],
  devices: [["path", { d: "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" }], ["path", { d: "M10 19v-3.96 3.15" }], ["path", { d: "M7 19h5" }], ["rect", { width: "6", height: "10", x: "16", y: "12", rx: "2" }]],
  staff: [["path", { d: "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" }], ["rect", { width: "20", height: "14", x: "2", y: "6", rx: "2" }]],
  packs: [["path", { d: "m7.5 4.27 9 5.15" }], ["path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }], ["path", { d: "m3.3 7 8.7 5 8.7-5" }], ["path", { d: "M12 22V12" }]],
  security: [["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }], ["path", { d: "m9 12 2 2 4-4" }]],
  plan: [["path", { d: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" }], ["path", { d: "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" }], ["path", { d: "M12 17.5v-11" }]],
  menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
  chart: [["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }], ["path", { d: "M18 17V9" }], ["path", { d: "M13 17V5" }], ["path", { d: "M8 17v-3" }]],
  logout: [["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }], ["path", { d: "m16 17 5-5-5-5" }], ["path", { d: "M21 12H9" }]],
  updown: [["path", { d: "m7 15 5 5 5-5" }], ["path", { d: "m7 9 5-5 5 5" }]],
  panel: [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M9 3v18" }]],
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  userPlus: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M19 8v6" }], ["path", { d: "M22 11h-6" }]],
  user: [["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }], ["circle", { cx: "12", cy: "7", r: "4" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  checkCircle: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m9 12 2 2 4-4" }]],
  lock: [["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }]],
  arrow: [["path", { d: "M5 12h14" }], ["path", { d: "m12 5 7 7-7 7" }]],
  activity: [["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]],
  inbox: [["path", { d: "M22 12h-6l-2 3h-4l-2-3H2" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
  clock: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 6v6l4 2" }]],
  forward: [["path", { d: "m15 17 5-5-5-5" }], ["path", { d: "M4 18v-2a4 4 0 0 1 4-4h12" }]],
  mail: [["rect", { width: "20", height: "16", x: "2", y: "4", rx: "2" }], ["path", { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" }]],
  link: [["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }], ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }]],
  download: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "m7 10 5 5 5-5" }], ["path", { d: "M12 15V3" }]],
  alert: [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
  key: [["path", { d: "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" }], ["circle", { cx: "16.5", cy: "7.5", r: ".5", fill: "currentColor" }]],
  laptop: [["path", { d: "M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" }], ["path", { d: "M20.054 15.987H3.946" }]],
  monitor: [["rect", { width: "20", height: "14", x: "2", y: "3", rx: "2" }], ["path", { d: "M8 21h8" }], ["path", { d: "M12 17v4" }]],
  server: [["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2", ry: "2" }], ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2", ry: "2" }], ["path", { d: "M6 6h.01" }], ["path", { d: "M6 18h.01" }]],
  phone: [["rect", { width: "14", height: "20", x: "5", y: "2", rx: "2", ry: "2" }], ["path", { d: "M12 18h.01" }]],
  terminal: [["path", { d: "m4 17 6-6-6-6" }], ["path", { d: "M12 19h8" }]],
  globe: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }], ["path", { d: "M2 12h20" }]],
  message: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  file: [["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }], ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }], ["path", { d: "M10 9H8" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
  sliders: [["path", { d: "M4 21v-7" }], ["path", { d: "M4 10V3" }], ["path", { d: "M12 21v-9" }], ["path", { d: "M12 8V3" }], ["path", { d: "M20 21v-5" }], ["path", { d: "M20 12V3" }], ["path", { d: "M2 14h4" }], ["path", { d: "M10 8h4" }], ["path", { d: "M18 16h4" }]],
  search: [["circle", { cx: "11", cy: "11", r: "8" }], ["path", { d: "m21 21-4.3-4.3" }]],
  ban: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m4.9 4.9 14.2 14.2" }]],
  refresh: [["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }]],
  copy: [["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
};

function icon(name) {
  return s("svg", { class: "ico", viewBox: "0 0 24 24", "aria-hidden": "true" }, (ICONS[name] ?? []).map(([tag, attrs]) => s(tag, attrs)));
}

/** A page title: Young Serif, one vermilion accent word (same face, not italic) with the red pen under it. */
function title(before, accent, after = "") {
  return h(
    "h1",
    {},
    before ? `${before} ` : null,
    h(
      "span",
      { class: "pen" },
      h("span", { class: "accent", text: accent }),
      s("svg", { class: "pen-u", viewBox: "0 0 200 24", preserveAspectRatio: "none", "aria-hidden": "true" }, s("path", { pathLength: "1", d: "M4 15 C 38 8, 80 18, 118 11 S 178 7, 196 12" })),
    ),
    after,
  );
}

/** The double-ruled stamp: vermilion APROBAT on approved things, ink while something waits. */
const stamp = (text, opts = {}) => h("span", { class: `stamp${opts.ink ? " ink" : ""}${opts.big ? " big" : ""}${opts.pop ? " pop" : ""}`, "aria-hidden": "true", text });

const AV_COLORS = 5;
function initials(name) {
  const words = String(name ?? "").replace(/[^\p{L}\p{N}\s]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : (words[0][1] ?? ""))).toUpperCase();
}
function avatar(name, size = "") {
  let hash = 0;
  for (const char of String(name ?? "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return h("span", { class: `av c${(hash % AV_COLORS) + 1}${size ? ` ${size}` : ""}`, "aria-hidden": "true", text: initials(name) });
}

/** A slug like "contabila-ana" reads as "Contabila Ana"; anything else stays as it is. */
function staffName(id) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || /^[0-9a-f]{12,}$/.test(id.replace(/-/g, ""))) return id;
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** An OS icon and name, guessed from a device or session label. */
function osOf(text, runner = false) {
  const value = String(text ?? "").toLowerCase();
  if (runner) return { icon: "server", label: null };
  if (/^browser|chrome|firefox|safari|edge/.test(value)) return { icon: "globe", label: "Browser" };
  if (/android|iphone|ios|ipad/.test(value)) return { icon: "phone", label: /android/.test(value) ? "Android" : "iOS" };
  if (/mac|imac/.test(value)) return { icon: "laptop", label: "macOS" };
  if (/windows|\bwin\b|\bpc\b/.test(value)) return { icon: "monitor", label: "Windows" };
  if (/linux|ubuntu|debian|fedora/.test(value)) return { icon: "terminal", label: "Linux" };
  return { icon: "laptop", label: null };
}

const bone = (cls) => h("span", { class: `bone ${cls}` });
const bones = (count, cls) => Array.from({ length: count }, () => bone(cls));
/** A card-shaped skeleton: title, a number or a chart, rows. */
const cardSkeleton = (rows = 3, opts = {}) =>
  h("div", { class: `card ${opts.cls ?? ""}` }, bone("b-line m"), opts.number ? bone("b-num") : null, opts.chart ? bone("b-chart") : null, bones(rows, "b-row"));
const headSkeleton = () => h("div", { class: "page-head" }, h("div", {}, bone("b-title"), bone("b-sub")));

function fmtDate(iso) {
  if (!iso) return t("common.never");
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

function fmtWhen(iso) {
  if (!iso) return t("common.never");
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return t("common.now");
  if (ms < 3_600_000) return t("common.minAgo", { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t("common.hAgo", { n: Math.floor(ms / 3_600_000) });
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

const fmtDay = (day) => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`)).replace(".", "");
const fmtWeekday = (day) => new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`)).replace(/\./g, "");
const fmtNum = (n) => new Intl.NumberFormat(locale()).format(n);

async function fingerprint(signPublicKey) {
  try {
    const b64 = signPublicKey.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32).toUpperCase();
    return hex.match(/.{4}/g).join(" ");
  } catch {
    return "";
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h("textarea", { class: "visually-hidden" });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (button) {
    const before = button.textContent;
    button.textContent = t("common.copied");
    setTimeout(() => (button.textContent = before), 1600);
  }
}

// ---- API -------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { "x-zen-web": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, t("err.offline"), "offline");
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, typeof json.error === "string" ? json.error : t("err.generic"), json.code ?? null);
  return json;
}

function messageOf(error) {
  if (!(error instanceof ApiError)) return t("err.generic");
  if (error.code === "rate_limited") return t("err.limited");
  if (error.code && DICT.ro[`err.code.${error.code}`] !== undefined) return t(`err.code.${error.code}`);
  if (error.message.startsWith("This invitation is for ")) return t("err.inviteOther");
  const key = HUB_MESSAGES[error.message];
  return key === undefined ? error.message : t(key);
}

/** Sends people to sign in (or to the two-factor step) when the hub asks for it. */
function handleAuth(error) {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "signed_out" || error.code === "two_factor_required" || error.code === "two_factor_setup_required") {
    state.me = null;
    rememberNext();
    go("intra", { replace: true });
    return true;
  }
  return false;
}

/** Runs a button's action: spinner on that button only, the error under the form. */
async function act(button, errorEl, fn) {
  if (button) {
    button.disabled = true;
    button.classList.add("busy");
  }
  if (errorEl) errorEl.textContent = "";
  try {
    return await fn();
  } catch (error) {
    if (handleAuth(error)) return undefined;
    if (errorEl) errorEl.textContent = messageOf(error);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("busy");
    }
  }
}

/** A remove button that asks once ("Sigur?") before acting. */
function confirmButton(label, onConfirm) {
  const button = h("button", { class: "btn danger small", type: "button", text: label });
  let armed = false;
  let timer = 0;
  button.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      button.textContent = `${t("common.sure")} ${label}`;
      timer = setTimeout(() => {
        armed = false;
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = label;
    await onConfirm(button);
  });
  return button;
}

// ---- State and routing -----------------------------------------------------------------------

const state = { me: null, companyId: null, overview: null, overviewAt: 0, overviewFor: null, range: 30, access: null, accessFor: null };
let ticket = 0;
const root = document.getElementById("root");

// `need`: the permission the page needs (v9 roles); without it the page is hidden from the menu.
const PAGES = {
  acasa: { nav: "home", icon: "home", draw: pageHome },
  firma: { nav: "company", icon: "company", draw: pageCompany },
  echipa: { nav: "team", icon: "team", draw: pageTeam },
  roluri: { nav: "roles", icon: "key", draw: pageRoles, need: "echipa:vede", sub: true },
  dispozitive: { nav: "devices", icon: "devices", draw: pageDevices },
  angajati: { nav: "staff", icon: "staff", draw: pageStaff, need: "angajati:vede" },
  pachete: { nav: "packs", icon: "packs", draw: pagePacks, need: "pachete:vede" },
  securitate: { nav: "security", icon: "security", draw: pageSecurity },
  jurnal: { nav: "journal", icon: "clock", draw: pageJournal, need: "echipa:administreaza", sub: true },
  plan: { nav: "plan", icon: "plan", draw: pagePlan, need: "facturare:vede" },
  biblioteca: { nav: "library", icon: "packs", draw: pageLibrary },
  // The platform admin (hub staff only); the older /app/verificare and /app/cifre open its tabs.
  admin: { nav: "admin", icon: "sliders", draw: pageAdmin, only: () => state.me?.admin != null },
  verificare: { redirect: "admin/biblioteca", hidden: true },
  cifre: { redirect: "admin/cifre", hidden: true },
};
/** The phone's bottom bar: the pages used most; the rest are in the drawer ("Mai mult"). */
const BOTTOM = ["acasa", "echipa", "dispozitive", "angajati"];

const pageName = () => location.pathname.replace(/^\/app\/?/, "").split("/")[0] || "acasa";

function go(name, opts = {}) {
  const path = `/app/${name}${opts.hash ?? ""}`;
  if (opts.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route();
}

function rememberNext() {
  const name = pageName();
  if (name === "intra") return;
  try {
    sessionStorage.setItem("zen.next", `${location.pathname}${location.hash}`);
  } catch {}
}

function takeNext() {
  try {
    const next = sessionStorage.getItem("zen.next");
    sessionStorage.removeItem("zen.next");
    if (next && /^\/app\/[a-z]*/.test(next) && !next.startsWith("/app/intra")) return next;
  } catch {}
  return "/app/acasa";
}

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function setCompany(id) {
  state.companyId = id;
  state.overview = null;
  state.access = null;
  store("zen.company", id);
}

async function loadMe() {
  state.me = await api("GET", "/v1/me");
  // No choice in this browser yet: the account's language (set in the app or here) wins.
  if (stored("zen.lang") === null) useLanguage(state.me.preferences?.language);
  // The library page and, for hub reviewers, the review queue; a hub without the library answers 404.
  state.library = await api("GET", "/v1/library/me").catch(() => null);
  const companies = state.me.companies ?? [];
  const wanted = state.companyId ?? stored("zen.company");
  state.companyId = companies.some((company) => company.id === wanted) ? wanted : (companies[0]?.id ?? null);
  return state.me;
}

const currentCompany = () => state.me?.companies.find((company) => company.id === state.companyId) ?? null;
const isManager = (role) => role === "owner" || role === "admin";

/** v9 roles: what I may do in the current company (the hub checks it again on every request). */
async function loadAccess() {
  if (state.companyId === null) return (state.access = null);
  if (state.accessFor === state.companyId && state.access !== null) return state.access;
  const companyId = state.companyId;
  const answer = await api("GET", `/v1/companies/${encodeURIComponent(companyId)}/access`);
  if (companyId === state.companyId) {
    state.access = answer.access;
    state.accessFor = companyId;
  }
  return answer.access;
}

function can(permission) {
  const access = state.access;
  if (access === null || access === undefined) return isManager(currentCompany()?.role);
  if (access.role === "owner" || access.role === "admin") return true;
  return access.permissions.includes(permission) || access.scoped.some((grant) => grant.permission === permission);
}

const pageAllowed = (page) => page.need === undefined || state.companyId === null || can(page.need);

async function overview(force = false) {
  if (state.companyId === null) return null;
  if (!force && state.overview !== null && state.overviewFor === state.companyId && Date.now() - state.overviewAt < 20_000) return state.overview;
  const companyId = state.companyId;
  const data = await api("GET", `/v1/companies/${encodeURIComponent(companyId)}/overview`);
  if (companyId === state.companyId) {
    state.overview = data;
    state.overviewAt = Date.now();
    state.overviewFor = companyId;
    updateBadge();
  }
  return data;
}

const approvalsCount = (data) =>
  data === null ? 0 : data.approvals.devices.length + data.approvals.handovers.length + (state.me?.invites?.length ?? 0);

function updateBadge() {
  const count = approvalsCount(state.overview);
  for (const badge of document.querySelectorAll("[data-badge]")) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

async function route() {
  const mine = ++ticket;
  const name = pageName();
  window.scrollTo(0, 0);
  if (name === "intra") return drawLogin();
  if (state.me === null) {
    try {
      await loadMe();
    } catch (error) {
      if (mine !== ticket) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        rememberNext();
        return go("intra", { replace: true });
      }
      return drawFatal(error);
    }
  }
  if (mine !== ticket) return;
  if (state.me.twoFactor.gate !== "ok") {
    rememberNext();
    return go("intra", { replace: true });
  }
  if (name === "invitatie") return drawShell(null, (main) => pageInvite(main, mine));
  const page = PAGES[name];
  if (page?.redirect !== undefined) return go(page.redirect, { replace: true, hash: location.hash });
  if (page === undefined || (page.reviewer && state.library?.reviewer !== true) || (page.only !== undefined && !page.only())) return go("acasa", { replace: true });
  await loadAccess().catch(() => undefined);
  if (mine !== ticket) return;
  drawShell(name, (main) => (pageAllowed(page) ? page.draw(main, mine) : main.replaceChildren(h("section", { class: "card" }, emptyState("lock", t("access.denied"), t("access.deniedLead"))))));
}

function drawFatal(error) {
  authPage(
    title(t("fatal.title"), t("fatal.accent"), "."),
    h("p", { class: "error", text: messageOf(error) }),
    h("button", { class: "btn primary", type: "button", text: t("common.retry"), onclick: () => route() }),
  );
}

const lockup = (cls = "lockup", width = 140) => h("img", { class: cls, src: "/app/assets/logo.svg", alt: "Zen Staff", width: String(width), height: String(Math.round(width * 0.172)) });
const mark = () => h("img", { class: "mark", src: "/app/assets/mark.svg", alt: "", width: "30", height: "30" });

// ---- Shell: fixed sidebar (rail on tablets, drawer on phones), fluid content --------------------

const RAIL_BELOW = 1200;
const PHONE_BELOW = 768;

function railWanted() {
  if (window.innerWidth < PHONE_BELOW) return false;
  if (window.innerWidth < RAIL_BELOW) return true;
  return stored("zen.rail") === "1";
}

/** A small menu that opens under (or over) its button and closes on the next outside click. */
function popover(holder, button, items) {
  let pop = null;
  const close = () => {
    pop?.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", onKey);
  };
  const outside = (event) => {
    if (!holder.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  };
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (pop !== null) return close();
    pop = h("div", { class: "pop", role: "menu" }, items(close));
    holder.append(pop);
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", onKey);
    pop.querySelector("a, button")?.focus();
  });
}

function companySwitcher(companies) {
  const company = currentCompany();
  if (company === null) {
    return h("div", { class: "switch" }, h("a", { class: "switch-btn", href: "/app/firma" }, h("span", { class: "co-tile" }, icon("plus")), h("span", { class: "switch-txt" }, h("b", { text: t("nav.newCompany") }))));
  }
  const button = h(
    "button",
    { class: "switch-btn", type: "button", title: company.name, "aria-label": `${t("nav.switch")}: ${company.name}` },
    h("span", { class: "co-tile", text: initials(company.name) }),
    h("span", { class: "switch-txt" }, h("b", { text: company.name }), h("span", { text: t(`role.${company.role}`) })),
    icon("updown"),
  );
  const holder = h("div", { class: "switch" }, button);
  popover(holder, button, (close) => [
    companies.map((item) =>
      h(
        "button",
        {
          class: "pop-item",
          type: "button",
          role: "menuitem",
          "aria-current": item.id === state.companyId ? "true" : null,
          onclick: () => {
            close();
            if (item.id !== state.companyId) {
              setCompany(item.id);
              route();
            }
          },
        },
        h("span", { class: "co-tile", text: initials(item.name) }),
        h("span", { class: "grow", text: item.name }),
      ),
    ),
    h("div", { class: "pop-sep" }),
    h("a", { class: "pop-item", role: "menuitem", href: "/app/firma#alta" }, icon("plus"), t("nav.newCompany")),
  ]);
  return holder;
}

function userMenu(me) {
  const button = h(
    "button",
    { class: "user-btn", type: "button", "aria-label": t("nav.account"), title: me.user.email },
    avatar(me.user.name),
    h("span", { class: "user-txt" }, h("b", { text: me.user.name }), h("span", { text: me.user.email })),
    icon("updown"),
  );
  const holder = h("div", { class: "user" }, button);
  popover(holder, button, () => [
    h("a", { class: "pop-item", role: "menuitem", href: "/app/securitate" }, icon("security"), t("nav.security")),
    h("a", { class: "pop-item", role: "menuitem", href: "/app/dispozitive" }, icon("devices"), t("nav.devices")),
    LANGS.filter((lang) => lang !== LANG).map((lang) => h("button", { class: "pop-item", type: "button", role: "menuitem", lang, onclick: () => setLanguage(lang) }, icon("globe"), LANG_NAMES[lang])),
    h("div", { class: "pop-sep" }),
    h("button", { class: "pop-item", type: "button", role: "menuitem", onclick: (event) => signOut(event.currentTarget) }, icon("logout"), t("nav.logout")),
  ]);
  return holder;
}

async function signOut(button) {
  await act(button, null, async () => {
    await api("POST", "/v1/web/auth/logout").catch(() => api("POST", "/v1/web/auth/forget"));
    state.me = null;
    state.overview = null;
    go("intra", { replace: true });
  });
}

function drawShell(active, draw) {
  root.removeAttribute("aria-busy");
  const me = state.me;
  const companies = me.companies ?? [];
  const app = h("div", { class: `app${railWanted() ? " rail" : ""}` });
  const closeDrawer = () => app.classList.remove("side-open");
  const collapse = h("button", { class: "icon-btn side-collapse", type: "button" }, icon("panel"));
  const labelCollapse = () => {
    const open = !app.classList.contains("rail") || app.classList.contains("side-open");
    collapse.setAttribute("aria-label", open ? t("nav.collapse") : t("nav.expand"));
    collapse.title = collapse.getAttribute("aria-label");
  };
  collapse.addEventListener("click", () => {
    if (window.innerWidth < RAIL_BELOW) app.classList.toggle("side-open");
    else {
      const rail = !app.classList.contains("rail");
      app.classList.toggle("rail", rail);
      store("zen.rail", rail ? "1" : null);
    }
    labelCollapse();
  });
  labelCollapse();
  const nav = h(
    "nav",
    { class: "nav", "aria-label": t("nav.pages") },
    Object.entries(PAGES).filter(([, page]) => !page.hidden && pageAllowed(page) && (!page.reviewer || state.library?.reviewer === true) && (page.only === undefined || page.only())).map(([name, page]) =>
      h(
        "a",
        { class: `nav-item${page.sub ? " sub" : ""}`, href: `/app/${name}`, "aria-current": name === active ? "page" : null, title: t(`nav.${page.nav}`) },
        icon(page.icon),
        h("span", { class: "label", text: t(`nav.${page.nav}`) }),
        name === "acasa" ? h("span", { class: "count", dataset: { badge: "" }, hidden: true }) : null,
      ),
    ),
  );
  const side = h(
    "aside",
    { class: "side", id: "side" },
    h("div", { class: "side-head" }, h("a", { class: "brand", href: "/app/acasa", "aria-label": "Zen Staff" }, lockup(), mark()), collapse),
    companySwitcher(companies),
    nav,
    h("div", { class: "side-foot" }, userMenu(me)),
  );
  const company = currentCompany();
  const topbar = h(
    "header",
    { class: "topbar" },
    h("a", { href: "/app/acasa", "aria-label": "Zen Staff" }, mark()),
    h("span", { class: "co", text: company?.name ?? "Zen Staff" }),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("nav.menu"), "aria-controls": "side", onclick: () => app.classList.add("side-open") }, icon("menu")),
  );
  const bottom = h(
    "nav",
    { class: "bottom-nav", "aria-label": t("nav.pages") },
    BOTTOM.map((name) =>
      h(
        "a",
        { href: `/app/${name}`, "aria-current": name === active ? "page" : null },
        icon(PAGES[name].icon),
        t(`nav.short.${PAGES[name].nav}`),
        name === "acasa" ? h("span", { class: "count", dataset: { badge: "" }, hidden: true }) : null,
      ),
    ),
    h("button", { type: "button", "aria-controls": "side", onclick: () => app.classList.add("side-open") }, icon("menu"), t("nav.more")),
  );
  const main = h("main", { class: "main", id: "main" });
  append(app, [side, h("div", { class: "scrim", onclick: closeDrawer }), topbar, main, bottom]);
  root.replaceChildren(roughFilter(), app);
  updateBadge();
  draw(main);
  if (state.companyId !== null) {
    (active === "acasa" ? Promise.resolve(state.overview) : overview())
      .then((data) => {
        if (active === "plan" || !main.isConnected || data == null || main.querySelector("[data-billing-banner]")) return;
        const banner = billingBanner(data.plan);
        if (banner !== null) main.prepend(banner);
      })
      .catch(() => undefined);
  }
}

/** The pen and the stamp get a slightly rough edge, like ink on paper (filter: url(#rough)). */
function roughFilter() {
  return s(
    "svg",
    { width: "0", height: "0", "aria-hidden": "true", class: "visually-hidden" },
    s("filter", { id: "rough", x: "-5%", y: "-20%", width: "110%", height: "140%" }, s("feTurbulence", { type: "fractalNoise", baseFrequency: "0.8", numOctaves: "2", seed: "3", result: "n" }), s("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: "2.4" })),
  );
}

let lastWide = window.innerWidth >= RAIL_BELOW;
window.addEventListener("resize", () => {
  const app = root.querySelector(".app");
  if (app === null) return;
  const wide = window.innerWidth >= RAIL_BELOW;
  if (wide !== lastWide) {
    lastWide = wide;
    app.classList.remove("side-open");
    app.classList.toggle("rail", railWanted());
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") root.querySelector(".app.side-open")?.classList.remove("side-open");
});

function head(titleEl, sub, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, titleEl, sub ? h("p", { class: "sub" }, sub) : null), actions.length ? h("div", { class: "actions" }, actions) : null);
}

const companyPath = (suffix = "") => `/v1/companies/${encodeURIComponent(state.companyId)}${suffix}`;

function planLine(plan) {
  if (plan.kind !== "hosted") return `${t(`plan.${plan.kind}`)} · ${t("plan.free")}`;
  return `${t("plan.hosted")} · ${plan.status === "none" ? t("plan.trial") : t(`plan.status.${plan.status}`)}`;
}

/** The banner every page shows while the hosted plan is not paid (warn) or read-only. */
function billingBanner(plan, graceEndsAt = plan?.graceEndsAt ?? null) {
  if (!plan || plan.kind !== "hosted" || plan.access === "full" || plan.access === undefined) return null;
  const reason = plan.reason ?? (plan.status === "past_due" ? "payment_failed" : plan.status === "incomplete" ? "pending" : plan.status === "unpaid" ? "unpaid" : plan.status === "paused" ? "paused" : plan.status === "canceled" ? "canceled" : "grace_over");
  const key = plan.access === "readonly" && reason === "payment_failed" ? "grace_over" : reason;
  const text = t(`plan.banner.${key}`, { date: graceEndsAt ? fmtDate(graceEndsAt) : "" });
  return h(
    "div",
    { class: `banner${plan.access === "readonly" ? " stop" : ""}`, role: "status", dataset: { billingBanner: "" } },
    icon("alert"),
    h("span", { class: "grow", text }),
    pageName() === "plan" ? null : h("a", { class: "btn small", href: "/app/plan" }, t("plan.bannerGo"), icon("arrow")),
  );
}

/** Draws a skeleton, loads, then swaps in the content; errors show a retry. */
async function load(main, mine, skeleton, loader, render) {
  main.replaceChildren(...skeleton);
  try {
    const data = await loader();
    if (mine !== ticket) return;
    main.replaceChildren();
    render(data);
  } catch (error) {
    if (mine !== ticket || handleAuth(error)) return;
    main.replaceChildren(h("div", { class: "card" }, h("h2", { text: t("common.loadFailed") }), h("p", { class: "error", text: messageOf(error) }), h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", text: t("common.retry"), onclick: () => route() }))));
  }
}

/** An empty state that teaches the next step: what this is, what to do, the button to do it. */
function emptyState(iconName, heading, text, ...actions) {
  return h("div", { class: "empty" }, h("span", { class: "e-ico" }, icon(iconName)), h("b", { text: heading }), h("p", { text }), actions.length ? h("div", { class: "row" }, actions) : null);
}

const cardHead = (text, iconName, ...right) => h("div", { class: "card-head" }, h("h2", {}, iconName ? icon(iconName) : null, text), right);
const more = (href, text = t("common.seeAll")) => h("a", { class: "more", href }, text, icon("arrow"));
const downloadLink = (cls = "btn") => h("a", { class: cls, href: LANDING, target: "_blank", rel: "noopener" }, icon("download"), t("common.download"));

function noCompany(main) {
  main.replaceChildren(
    head(title(t("home.noCompany"), t("home.noCompanyAccent"), "."), t("home.noCompanyLead")),
    h("div", { class: "cols" }, createCompanyCard(), invitesForMeCard()),
  );
}

// ---- Sign-in: the form on paper, the painted panel beside it (like the landing hero) ----------

function authPage(...children) {
  root.removeAttribute("aria-busy");
  const glimpse = h(
    "div",
    { class: "glimpse" },
    h("img", { class: "brand-sm", src: "/app/assets/logo.svg", alt: "", width: "132", height: "23" }),
    h("p", { class: "quote" }, `${t("login.quote1")} `, h("span", { class: "accent", text: t("login.quoteAccent") }), ` ${t("login.quote2")}`),
    h(
      "div",
      { class: "ap" },
      h("div", { class: "ap-top" }, avatar(t("login.glimpseWho"), "sm"), h("b", { text: t("login.glimpseWho") }), h("span", { text: `· ${t("login.glimpseRole")}` }), h("span", { class: "chip", text: t("login.glimpseChip") })),
      h("div", { class: "ap-t", text: t("login.glimpseTitle") }),
      h("div", { class: "ap-m", text: t("login.glimpseMeta") }),
      h("div", { class: "ap-act" }),
      stamp(t("home.stampApproved"), { pop: true }),
    ),
  );
  root.replaceChildren(
    roughFilter(),
    h(
      "div",
      { class: "auth" },
      h(
        "div",
        { class: "auth-l" },
        h("a", { class: "brand-row", href: LANDING, "aria-label": "Zen Staff" }, lockup("lockup", 168)),
        h("main", { class: "auth-form" }, children),
        h("div", { class: "auth-foot" }, h("a", { href: LANDING, text: t("login.landing") }), h("span", { text: "zenstaff.app" }), langSwitch()),
      ),
      h("div", { class: "auth-r art morning", "aria-hidden": "true" }, glimpse),
    ),
  );
}

async function drawLogin() {
  // Already signed in (or half-way, at the two-factor step)?
  try {
    await loadMe();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.me = null;
      return drawEmailStep();
    }
    return drawFatal(error);
  }
  return continueAfterSignIn();
}

async function continueAfterSignIn() {
  const gate = state.me.twoFactor.gate;
  if (gate === "verify") return drawTotpVerify();
  if (gate === "enroll") return drawTotpSetup();
  const next = takeNext();
  history.replaceState(null, "", next);
  route();
}

let pollTimer = 0;

function drawEmailStep() {
  clearTimeout(pollTimer);
  const email = h("input", { type: "email", name: "email", autocomplete: "email", required: true, inputmode: "email", placeholder: t("ph.email") });
  const send = h("button", { class: "btn loud block", type: "submit", text: t("login.send") });
  const error = h("p", { class: "error", role: "alert" });
  const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("login.email"), email), send, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(send, error, async () => {
      const address = email.value.trim();
      const started = await api("POST", "/v1/auth/start", { email: address, lang: LANG });
      drawCodeStep(address, started);
    });
  });
  const passkey = h("button", { class: "btn block", type: "button" }, icon("key"), t("login.passkey"));
  const passkeyError = h("p", { class: "error", role: "alert" });
  passkey.addEventListener("click", () => passkeySignIn(passkey, passkeyError));
  authPage(
    title(t("login.title"), t("login.titleAccent"), "."),
    h("p", { class: "lede", text: t("login.lead") }),
    form,
    h("div", { class: "divider", text: t("login.or") }),
    passkey,
    passkeyError,
    h("p", { class: "note" }, icon("lock"), h("span", { text: t("login.note") })),
  );
  email.focus();
}

function drawCodeStep(address, started) {
  const code = h("input", { class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]*", "aria-label": t("login.code") });
  const enter = h("button", { class: "btn loud block", type: "submit", text: t("login.enter") });
  const error = h("p", { class: "error", role: "alert" });
  const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("login.code"), code), enter, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(enter, error, async () => {
      await api("POST", "/v1/web/auth/verify", { email: address, code: code.value.trim() });
      clearTimeout(pollTimer);
      await loadMe();
      await continueAfterSignIn();
    });
  });
  const other = h("button", { class: "btn quiet small", type: "button", text: t("login.other"), onclick: () => drawEmailStep() });
  authPage(title(t("login.codeTitle"), t("login.codeAccent"), "."), h("p", { class: "lede", text: t("login.codeLead", { email: address }) }), form, h("p", { class: "note" }, icon("mail"), h("span", { text: t("login.waitingLink") })), h("div", { class: "row" }, other));
  code.focus();
  // The e-mail link approves the same request from any device; poll for it.
  const startedAt = Date.now();
  const poll = async () => {
    if (pageName() !== "intra" || Date.now() - startedAt > 15 * 60_000) return;
    try {
      const result = await api("POST", "/v1/web/auth/poll", { requestId: started.requestId, pollSecret: started.pollSecret });
      if (result.pending === false) {
        await loadMe();
        return continueAfterSignIn();
      }
    } catch {}
    pollTimer = setTimeout(poll, 3000);
  };
  pollTimer = setTimeout(poll, 3000);
}

async function passkeySignIn(button, errorEl) {
  const lib = globalThis.SimpleWebAuthnBrowser;
  if (lib === undefined || !lib.browserSupportsWebAuthn()) {
    errorEl.textContent = t("login.passkeyNo");
    return;
  }
  await act(button, errorEl, async () => {
    const started = await api("POST", "/v1/auth/passkey/start", { lang: LANG });
    const token = new URL(started.url).searchParams.get("t");
    const { options } = await api("POST", "/v1/passkeys/login/options", { t: token });
    let response;
    try {
      response = await lib.startAuthentication({ optionsJSON: options });
    } catch (error) {
      throw new ApiError(0, error && (error.name === "NotAllowedError" || error.name === "AbortError") ? t("login.passkeyCancelled") : t("err.generic"), "passkey");
    }
    try {
      await api("POST", "/v1/passkeys/login/finish", { t: token, response });
    } catch (error) {
      if (error instanceof ApiError && error.code === "passkey_refused") throw new ApiError(400, t("login.passkeyRefused"), "passkey");
      throw error;
    }
    const result = await api("POST", "/v1/web/auth/poll", { requestId: started.requestId, pollSecret: started.pollSecret });
    if (result.pending !== false) throw new ApiError(0, t("err.generic"), null);
    await loadMe();
    await continueAfterSignIn();
  });
}

function signOutLink() {
  const button = h("button", { class: "btn quiet small", type: "button", text: t("nav.logout") });
  button.addEventListener("click", () =>
    act(button, null, async () => {
      await api("POST", "/v1/web/auth/logout").catch(() => api("POST", "/v1/web/auth/forget"));
      state.me = null;
      drawEmailStep();
    }),
  );
  return h("div", { class: "row" }, button);
}

function drawTotpVerify() {
  let recovery = false;
  const input = h("input", { class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", "aria-label": t("twofa.code") });
  const label = h("label", {}, t("twofa.code"), input);
  const check = h("button", { class: "btn loud block", type: "submit", text: t("twofa.check") });
  const error = h("p", { class: "error", role: "alert" });
  const toggle = h("button", { class: "btn quiet small", type: "button", text: t("twofa.useRecovery") });
  toggle.addEventListener("click", () => {
    recovery = !recovery;
    label.firstChild.textContent = recovery ? t("twofa.recovery") : t("twofa.code");
    input.className = recovery ? "" : "code";
    input.maxLength = recovery ? 20 : 6;
    input.inputMode = recovery ? "text" : "numeric";
    input.value = "";
    toggle.textContent = recovery ? t("twofa.useCode") : t("twofa.useRecovery");
    input.focus();
  });
  const form = h("form", { class: "form", novalidate: true }, label, check, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(check, error, async () => {
      await api("POST", "/v1/auth/totp/verify", recovery ? { recoveryCode: input.value.trim() } : { code: input.value.trim() });
      await loadMe();
      await continueAfterSignIn();
    });
  });
  authPage(title(t("twofa.verifyTitle"), t("twofa.verifyAccent"), "."), h("p", { class: "lede", text: t("twofa.verifyLead") }), form, h("div", { class: "row" }, toggle), signOutLink());
  input.focus();
}

function qrSvg(qr) {
  return s("svg", { viewBox: `0 0 ${qr.size} ${qr.size}`, class: "qr", role: "img", "aria-label": "QR", "shape-rendering": "crispEdges" }, s("path", { d: qr.path, fill: "#121A2B" }));
}

/** The setup form (QR, key, first code); `done(codes)` gets the recovery codes. */
function totpSetupForm(done) {
  const holder = h("div", { class: "form" }, h("span", { class: "bone", style: "width:196px;height:196px" }), bone("b-line m"), bone("b-row"));
  api("POST", "/v1/auth/totp/setup")
    .then((setup) => {
      const code = h("input", { class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", "aria-label": t("twofa.code") });
      const enable = h("button", { class: "btn loud", type: "submit", text: t("twofa.enable") });
      const error = h("p", { class: "error", role: "alert" });
      const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("twofa.code"), code), h("div", { class: "row" }, enable), error);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        act(enable, error, async () => {
          const result = await api("POST", "/v1/auth/totp/enable", { code: code.value.trim() });
          done(result.recoveryCodes);
        });
      });
      holder.replaceChildren(h("p", { class: "small", text: t("twofa.scan") }), qrSvg(setup.qr), h("p", { class: "small muted", text: t("twofa.manual") }), h("div", { class: "secret", text: setup.secret }), form);
    })
    .catch((error) => {
      if (handleAuth(error)) return;
      holder.replaceChildren(h("p", { class: "error", text: messageOf(error) }));
    });
  return holder;
}

function recoveryCodesBlock(codes) {
  const copy = h("button", { class: "btn small", type: "button" }, icon("copy"), t("twofa.copyCodes"));
  copy.addEventListener("click", () => copyText(codes.join("\n"), copy));
  return h("div", {}, h("div", { class: "codes", "data-testid": "recovery-codes" }, codes.map((code) => h("span", { text: code }))), h("div", { class: "row" }, copy));
}

function drawTotpSetup() {
  authPage(
    title(t("twofa.setupTitle"), t("twofa.setupAccent"), "."),
    h("p", { class: "lede", text: t("twofa.setupLead") }),
    totpSetupForm((codes) => {
      const next = h("button", { class: "btn loud block", type: "button", text: t("twofa.codesDone") });
      next.addEventListener("click", async () => {
        await loadMe();
        continueAfterSignIn();
      });
      authPage(title(t("twofa.codesTitle"), t("twofa.codesAccent"), "."), h("p", { class: "lede", text: t("twofa.codesLead") }), recoveryCodesBlock(codes), next);
    }),
    signOutLink(),
  );
}

// ---- Charts: hand-written SVG (area fill, faint grid, emphasised endpoint, tabular numbers) ----

/** A sparkline for a KPI tile: the area and line stretch; the end dot stays round (HTML on top). */
function sparkline(values, label) {
  const wrap = h("div", { class: "spark-end", role: "img", "aria-label": label });
  if (values.length < 2) return wrap;
  const max = Math.max(1, ...values);
  const x = (i) => (i / (values.length - 1)) * 100;
  const y = (v) => 36 - (v / max) * 32;
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
  append(wrap, [
    s(
      "svg",
      { class: "spark", viewBox: "0 0 100 40", preserveAspectRatio: "none", "aria-hidden": "true" },
      s("line", { class: "base", x1: "0", x2: "100", y1: "36", y2: "36" }),
      s("path", { class: "area", d: `${line} L100 36 L0 36 Z` }),
      s("path", { class: "line", d: line }),
    ),
    h("span", { class: "spark-dot", style: `left:100%;top:${(y(values.at(-1)) / 40) * 100}%` }),
  ]);
  return wrap;
}

const niceMax = (value) => {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
};

/** The activity chart: one series (tasks per day), redrawn at its real width, with a hover readout. */
function areaChart(days, valueOf, unit) {
  const wrap = h("div", { class: "chart-wrap" });
  const tip = h("div", { class: "tip", hidden: true });
  const values = days.map(valueOf);
  const total = values.reduce((a, b) => a + b, 0);
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `${fmtNum(total)} ${unit}: ${days.map((d, i) => `${fmtDay(d.day)} ${values[i]}`).join(", ")}`);
  const draw = () => {
    const width = Math.max(260, Math.round(wrap.clientWidth || 600));
    const height = 210;
    const pad = { l: 4, r: 40, t: 14, b: 26 };
    const max = niceMax(Math.max(...values, 1));
    const x = (i) => pad.l + (i / Math.max(1, values.length - 1)) * (width - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
    const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const grid = [0, 0.5, 1].map((f) => s("line", { x1: pad.l, x2: width - pad.r + 8, y1: y(max * f), y2: y(max * f) }));
    const labels = [0, 0.5, 1].map((f) => {
      const text = s("text", { x: width - pad.r + 12, y: y(max * f) + 4 });
      text.textContent = fmtNum(Math.round(max * f));
      return text;
    });
    const ticks = [0, Math.floor((values.length - 1) / 2), values.length - 1].map((i, k) => {
      const text = s("text", { x: x(i), y: height - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle" });
      text.textContent = i === values.length - 1 ? t("common.today") : fmtDay(days[i].day);
      return text;
    });
    const last = values.length - 1;
    const endLabel = s("text", { class: "end-label", x: x(last) - 8, y: y(values[last]) - 10, "text-anchor": "end" });
    endLabel.textContent = fmtNum(values[last]);
    const hair = s("line", { class: "hair", y1: pad.t, y2: height - pad.b, x1: -10, x2: -10 });
    const hdot = s("circle", { class: "hdot", r: "4.5", cx: -10, cy: -10 });
    const svg = s(
      "svg",
      { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" },
      s("g", { class: "grid" }, grid),
      labels,
      ticks,
      s("path", { class: "area", d: `${line} L${x(last)} ${y(0)} L${x(0)} ${y(0)} Z` }),
      s("path", { class: "line", d: line }),
      hair,
      hdot,
      s("circle", { class: "end", r: "5", cx: x(last), cy: y(values[last]) }),
      endLabel,
    );
    // Hover: the nearest day, a crosshair and a readout (the hit area is the whole plot).
    svg.addEventListener("pointermove", (event) => {
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const i = Math.max(0, Math.min(last, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * last)));
      hair.setAttribute("x1", x(i));
      hair.setAttribute("x2", x(i));
      hdot.setAttribute("cx", x(i));
      hdot.setAttribute("cy", y(values[i]));
      tip.hidden = false;
      svg.classList.add("hover");
      tip.replaceChildren(h("b", { text: fmtNum(values[i]) }), ` ${unit} · ${fmtWeekday(days[i].day)}`);
      tip.style.left = `${x(i)}px`;
      tip.style.top = `${y(values[i])}px`;
    });
    svg.addEventListener("pointerleave", () => {
      tip.hidden = true;
      svg.classList.remove("hover");
      hair.setAttribute("x1", -10);
      hair.setAttribute("x2", -10);
      hdot.setAttribute("cx", -10);
    });
    wrap.replaceChildren(svg, tip);
  };
  requestAnimationFrame(draw);
  let lastWidth = 0;
  new ResizeObserver(() => {
    const width = Math.round(wrap.clientWidth);
    if (width !== lastWidth && wrap.isConnected) {
      lastWidth = width;
      draw();
    }
  }).observe(wrap);
  return wrap;
}

// ---- Acasă -----------------------------------------------------------------------------------

const seenText = (iso) => (iso ? t("home.lastSeen", { when: fmtWhen(iso) }) : t("home.neverSeen"));

function greeting() {
  const hour = new Date().getHours();
  return t(hour < 11 ? "home.morning" : hour < 18 ? "home.day" : "home.evening");
}

const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || name;

function homeSkeleton() {
  return [
    h("section", { class: "home-art art dawn" }, headSkeleton(), h("div", { class: "kpis" }, bones(4, "b-kpi"))),
    h("div", { class: "bento" }, cardSkeleton(2, { cls: "w2" }), cardSkeleton(3, { number: true }), cardSkeleton(5, { cls: "tall" }), cardSkeleton(0, { cls: "w2", chart: true }), cardSkeleton(3), cardSkeleton(2, { cls: "w2" }), cardSkeleton(3)),
  ];
}

function pageHome(main, mine) {
  if (state.companyId === null) return noCompany(main);
  const role = currentCompany()?.role;
  const manager = isManager(role);
  load(
    main,
    mine,
    homeSkeleton(),
    async () => {
      const [data, company, packs, audit] = await Promise.all([
        overview(true),
        api("GET", companyPath()),
        api("GET", companyPath("/packs")).catch(() => ({ packs: [], status: [] })),
        manager ? api("GET", companyPath("/audit")).catch(() => ({ entries: [] })) : api("GET", "/v1/me/audit").catch(() => ({ entries: [] })),
      ]);
      return { data, company, packs, audit: audit.entries };
    },
    ({ data, company, packs, audit }) => {
      const full = data.activity !== null;
      const art = h(
        "section",
        { class: "home-art art dawn" },
        head(
          title(greeting(), firstName(state.me.user.name), "."),
          [h("span", { text: data.company.name }), h("span", { class: "dot-sep", text: t(`role.${data.role}`) }), h("span", { class: "dot-sep", text: planLine(data.plan) })],
          manager ? h("a", { class: "btn primary", href: "/app/echipa#invita" }, icon("userPlus"), t("home.invite")) : null,
          downloadLink("btn"),
        ),
        h("div", { class: "kpis" }, kpiTasks(data), kpiMembers(data), kpiDevices(data), kpiApprovals(data)),
      );
      append(main, [
        art,
        h(
          "div",
          { class: "bento" },
          approvalsCard(data),
          runnerCard(data.runners, data.staff.total),
          timelineCard(audit, manager),
          full ? activityCard(data) : null,
          packsHealthCard(packs, manager),
          teamCard(company, manager),
          data.staff.visible ? staffCard(data.staff) : null,
          myDevicesCard(),
        ),
      ]);
    },
  );
}

function kpiTasks(data) {
  const tile = h("a", { class: "kpi", href: "/app/angajati" }, h("div", { class: "kpi-top" }, t("home.kpiTasks"), icon("activity")));
  if (data.trend === null) return append(tile, [h("div", { class: "kpi-val num", text: "-" }), h("div", { class: "kpi-sub", text: t("home.kpiGuest") })]);
  const days = data.trend.activity.days.map((day) => day.tasks);
  const last7 = days.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = days.slice(-14, -7).reduce((a, b) => a + b, 0);
  const delta = last7 - prev7;
  return append(tile, [
    h("div", { class: "kpi-val num", text: fmtNum(last7) }),
    h("div", { class: "kpi-sub" }, delta === 0 ? t("home.kpiTasksSame") : [h("span", { class: "up", text: `${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}` }), ` ${t("home.kpiTasksSub", { d: "" }).trim()}`]),
    sparkline(days, `${t("home.kpiTasks")}: ${days.join(", ")}`),
  ]);
}

function kpiMembers(data) {
  const tile = h("a", { class: "kpi", href: "/app/echipa" }, h("div", { class: "kpi-top" }, t("home.kpiMembers"), icon("team")));
  const series = data.trend?.members.map((day) => day.total) ?? [];
  const grew = series.length > 0 ? series.at(-1) - series[0] : 0;
  const roles = ["owner", "admin", "member", "guest"].filter((r) => data.members.byRole[r] > 0).map((r) => `${data.members.byRole[r]} ${t(`role.${r}`).toLowerCase()}`);
  return append(tile, [
    h("div", { class: "kpi-val num", text: fmtNum(data.members.total) }),
    h("div", { class: "kpi-sub", text: grew > 0 ? t("home.kpiMembersSub", { n: grew }) : roles.join(" · ") }),
    series.length > 0 ? sparkline(series, `${t("home.kpiMembers")}: ${series.join(", ")}`) : null,
  ]);
}

/** My machines plus the company runners (each once): how many are online now. */
function knownDevices(data) {
  const seen = new Map();
  for (const machine of state.me.environments ?? []) seen.set(machine.id, { name: machine.name, online: machine.online });
  for (const runner of data?.runners ?? []) seen.set(runner.id, { name: runner.name, online: runner.online });
  return [...seen.values()];
}

function kpiDevices(data) {
  const devices = knownDevices(data);
  const online = devices.filter((device) => device.online).length;
  return h(
    "a",
    { class: "kpi", href: "/app/dispozitive" },
    h("div", { class: "kpi-top" }, t("home.kpiDevices"), icon("devices")),
    h("div", { class: "kpi-val num" }, fmtNum(online), devices.length > 0 ? h("small", { text: `/ ${fmtNum(devices.length)}` }) : null),
    h("div", { class: "kpi-sub", text: devices.length === 0 ? t("home.kpiDevicesNone") : devices.map((device) => device.name).slice(0, 3).join(", ") }),
    h("div", { class: "meter", role: "img", "aria-label": `${online} / ${devices.length}` }, devices.slice(0, 24).map((device) => h("i", { class: device.online ? "on" : "", title: device.name }))),
  );
}

function kpiApprovals(data) {
  const count = approvalsCount(data);
  const series = data.trend?.approvals.map((day) => day.n) ?? [];
  return h(
    "a",
    { class: "kpi", href: "#aprobari" },
    h("div", { class: "kpi-top" }, t("home.kpiApprovals"), icon("inbox")),
    h("div", { class: `kpi-val num${count > 0 ? " loud" : ""}`, text: fmtNum(count) }),
    h("div", { class: "kpi-sub", text: count > 0 ? t("home.kpiApprovalsSome") : t("home.kpiApprovalsNone") }),
    series.length > 0 ? sparkline(series, `${t("home.kpiApprovals")}: ${series.join(", ")}`) : null,
  );
}

function approvalItem({ who, kind, heading, metaText, metaMono, how, actions = [], approved = false }) {
  return h(
    "article",
    { class: "ap" },
    h("div", { class: "ap-top" }, who ? avatar(who, "sm") : null, who ? h("b", { text: who }) : null, h("span", { class: "chip", text: kind })),
    h("div", { class: "ap-t", text: heading }),
    metaMono || metaText ? h("div", { class: "ap-m" }, metaMono ? h("span", { class: "mono", text: metaMono }) : null, metaMono && metaText ? " · " : null, metaText) : null,
    how ? h("div", { class: "ap-m", text: how }) : null,
    h("div", { class: "ap-act" }, actions),
    stamp(approved ? t("home.stampApproved") : t("home.stampWaiting"), { ink: !approved }),
  );
}

function approvalsCard(data) {
  const items = [];
  for (const device of data.approvals.devices) {
    items.push(approvalItem({ who: device.userName, kind: t("home.apDevice"), heading: t("home.apDeviceTitle", { device: device.deviceLabel, runner: device.runnerName }), metaMono: device.fingerprint, metaText: fmtWhen(device.reportedAt), how: device.email === state.me.user.email ? t("home.apDeviceHowMine") : t("home.apDeviceHow", { name: firstName(device.userName) }) }));
  }
  for (const handover of data.approvals.handovers) {
    items.push(approvalItem({ who: handover.fromName, kind: t("home.apHandover"), heading: t("home.apHandoverTitle", { name: handover.fromName }), metaText: fmtWhen(handover.createdAt), how: t("home.apHandoverHow") }));
  }
  for (const invite of state.me.invites ?? []) {
    items.push(approvalItem({ who: invite.companyName, kind: t("home.apInvite"), heading: t("home.apInviteTitle", { company: invite.companyName, role: t(`role.${invite.role}`).toLowerCase() }), actions: [h("a", { class: "btn small primary", href: "/app/invitatie", text: t("invite.accept") })] }));
  }
  const waiting = items.length;
  if (data.invites.pending) {
    items.push(approvalItem({ kind: t("home.apInvitesSent"), heading: data.invites.pending === 1 ? t("home.apInvitesSentOne") : t("home.apInvitesSentTitle", { n: data.invites.pending }), how: t("home.apInvitesSentHow"), actions: [h("a", { class: "btn small", href: "/app/echipa", text: t("home.openTeam") })] }));
  }
  return h(
    "section",
    { class: "card w2", id: "aprobari", "aria-labelledby": "h-approvals" },
    h("div", { class: "card-head" }, h("h2", { id: "h-approvals" }, icon("inbox"), t("home.approvals")), h("span", { class: "meta-r", text: t("home.waiting", { n: waiting }) })),
    items.length === 0
      ? h("div", { class: "ap-empty" }, stamp(t("home.stampApproved"), { big: true, pop: true }), h("p", { text: t("home.approvalsEmpty") }))
      : h("div", { class: "aps" }, items),
    h("p", { class: "note" }, icon("lock"), h("span", { text: t("home.approvalsNote") })),
  );
}

function runnerCard(runners, staffTotal = null) {
  const card = h("section", { class: "card", "aria-labelledby": "h-runner" }, cardHead(t("home.runner"), "server"));
  card.querySelector("h2").id = "h-runner";
  if (runners.length === 0) {
    return append(card, [
      h("div", { class: "empty" }, h("span", { class: "e-ico" }, icon("server")), h("b", { text: t("home.runnerNoneT") })),
      h("ol", { class: "steps" }, h("li", { text: t("home.runnerStep1") }), h("li", { text: t("home.runnerStep2") }), h("li", { text: t("home.runnerStep3") })),
      h("div", { class: "foot" }, downloadLink("btn primary")),
    ]);
  }
  const [first, ...others] = runners;
  return append(card, [
    h("div", { class: "runner-state" }, first.online ? h("span", { class: "pulse", "aria-hidden": "true" }) : h("span", { class: "dot" }), first.online ? t("home.runnerOn") : first.lastSeenAt ? t("home.runnerOff", { when: fmtWhen(first.lastSeenAt) }) : t("home.neverSeen")),
    h("div", { class: "runner-name", text: first.name }),
    h(
      "dl",
      { class: "runner-facts" },
      h("div", {}, h("dt", { text: t("home.runnerOwner") }), h("dd", { text: first.ownerName })),
      first.aiAccount ? h("div", {}, h("dt", { text: t("home.runnerAccount") }), h("dd", { text: first.aiAccount.label })) : null,
      staffTotal !== null ? h("div", {}, h("dt", { text: t("home.runnerStaff") }), h("dd", { class: "num", text: fmtNum(staffTotal) })) : null,
    ),
    others.length > 0
      ? h("ul", { class: "list", style: "margin-top:12px" }, others.map((runner) => h("li", {}, h("span", { class: `dot${runner.online ? " on" : ""}` }), h("div", { class: "grow" }, h("div", { class: "title", text: runner.name }), h("div", { class: "meta", text: runner.online ? t("common.online") : seenText(runner.lastSeenAt) })))))
      : null,
  ]);
}

const AUDIT_ICONS = { invite: "mail", member: "team", runner: "server", staff: "staff", pack: "packs", grant: "key", settings: "lock", company: "company", passkey: "key", role: "key", team: "team", project: "file", auth: "user", audit: "download", siem: "forward", approval: "checkCircle" };

function auditLabel(action) {
  return DICT.ro[`audit.${action}`] ? t(`audit.${action}`) : action;
}

function timelineCard(entries, manager) {
  const card = h("section", { class: `card${entries.length > 3 ? " tall" : ""}`, "aria-labelledby": "h-timeline" }, cardHead(t("home.timeline"), "clock", manager ? more("/app/securitate#jurnal") : null));
  card.querySelector("h2").id = "h-timeline";
  if (entries.length === 0) return append(card, [emptyState("clock", t("home.timelineEmptyT"), manager ? t("home.timelineEmpty") : t("home.timelineMine"))]);
  return append(card, [
    h(
      "ol",
      { class: "tl" },
      entries.slice(0, 7).map((entry) =>
        h(
          "li",
          {},
          h("span", { class: "ti" }, icon(AUDIT_ICONS[entry.action.split(".")[0]] ?? "activity")),
          h("div", {}, h("div", { class: "tt", text: auditLabel(entry.action) }), h("div", { class: "tm", text: [entry.actorName ?? state.me.user.name, fmtWhen(entry.createdAt)].filter(Boolean).join(" · ") }), entry.detail ? h("div", { class: "td", lang: "en", text: entry.detail }) : null),
        ),
      ),
    ),
    manager ? null : h("p", { class: "note", text: t("home.timelineMine") }),
  ]);
}

function activityCard(data) {
  const card = h("section", { class: "card w2", "aria-labelledby": "h-activity" });
  const body = h("div", {});
  const seg = h("div", { class: "seg", role: "group", "aria-label": t("home.activity") });
  const draw = () => {
    const range = state.range === 7 ? data.activity : data.trend.activity;
    const days = range.days;
    for (const button of seg.children) button.setAttribute("aria-pressed", String(Number(button.dataset.range) === state.range));
    const empty = range.staffTasks === 0 && range.staffChanges === 0 && range.sharesCreated === 0;
    body.replaceChildren(
      ...[
      h(
        "div",
        { class: "stats", style: "margin-top:0;padding-top:0;border-top:0" },
        [
          [range.staffTasks, "home.tasks"],
          [range.staffChanges, "home.changes"],
          [range.sharesCreated, "home.shares"],
          [range.comments, "home.comments"],
        ].map(([n, key]) => h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(n) }), h("div", { class: "l", text: t(key) }))),
      ),
      empty ? null : areaChart(days, (day) => day.tasks, t("home.tasks").split(" ")[0]),
      empty ? emptyState("activity", t("home.activityEmptyT"), t("home.activityEmpty"), h("a", { class: "btn small", href: "/app/angajati" }, t("nav.staff"), icon("arrow"))) : null,
      ].filter(Boolean),
    );
  };
  for (const range of [7, 30]) {
    seg.append(
      h("button", {
        type: "button",
        dataset: { range: String(range) },
        text: t(range === 7 ? "home.days7" : "home.days30"),
        onclick: () => {
          state.range = range;
          draw();
        },
      }),
    );
  }
  append(card, [cardHead(t("home.activity"), "activity", seg), body, h("p", { class: "note" }, icon("lock"), h("span", { text: t("home.activityNote") }))]);
  card.querySelector("h2").id = "h-activity";
  draw();
  return card;
}

/** Per pack: how many machines run it, install it or fail, as one bar. */
function packHealth(pack, rows, compact = false) {
  const mine = rows.filter((row) => row.packId === pack.packId && !row.hidden);
  const ok = mine.filter((row) => row.state === "installed" || row.state === "runner-only").length;
  const wait = mine.filter((row) => row.state === "installing").length;
  const bad = mine.filter((row) => row.state === "failed");
  const total = mine.length;
  return h(
    "div",
    { class: "ph" },
    compact ? null : h("div", { class: "ph-top" }, h("span", { class: "mono", text: pack.packId }), h("span", { class: "mono v", text: pack.version }), bad.length > 0 ? h("span", { class: "chip loud" }, icon("alert"), t("home.packBad")) : wait > 0 ? h("span", { class: "chip", text: t("home.packWait") }) : total > 0 ? h("span", { class: "chip line" }, icon("check"), t("home.packOk")) : null),
    h("div", { class: "hbar", role: "img", "aria-label": t("home.packHealth", { ok, n: total }) }, total === 0 ? null : [ok ? h("i", { class: "ok", style: `flex:${ok}` }) : null, wait ? h("i", { class: "wait", style: `flex:${wait}` }) : null, bad.length ? h("i", { class: "bad", style: `flex:${bad.length}` }) : null]),
    h("div", { class: "ph-sub", text: total === 0 ? t("home.packNoStatus") : t("home.packHealth", { ok, n: total }) }),
    bad.map((row) => h("div", { class: "ph-err", text: `${row.environmentName}: ${row.error ?? t("packs.state.failed")}` })),
  );
}

function packsHealthCard(packs, manager) {
  const card = h("section", { class: "card", "aria-labelledby": "h-packs" }, cardHead(t("home.packs"), "packs", packs.packs.length > 0 ? more("/app/pachete") : null));
  card.querySelector("h2").id = "h-packs";
  if (packs.packs.length === 0) return append(card, [emptyState("packs", t("home.packsEmptyT"), t("home.packsEmpty"), downloadLink("btn small"))]);
  return append(card, [packs.packs.slice(0, 6).map((pack) => packHealth(pack, packs.status)), manager ? null : h("p", { class: "note", text: t("packs.mineOnly") })]);
}

function teamCard(company, manager) {
  const members = company.members;
  const card = h("section", { class: "card w2", "aria-labelledby": "h-team" }, cardHead(t("home.team"), "team", more("/app/echipa")));
  card.querySelector("h2").id = "h-team";
  if (members.length <= 1) {
    return append(card, [emptyState("userPlus", t("home.teamEmptyT"), t("home.teamEmpty"), manager ? h("a", { class: "btn primary small", href: "/app/echipa#invita" }, icon("userPlus"), t("home.invite")) : null)]);
  }
  const shown = members.slice(0, 11);
  return append(card, [
    h(
      "div",
      { class: "strip" },
      shown.map((member) => h("div", { class: "person" }, avatar(member.name), h("div", { class: "grow" }, h("b", { text: member.userId === state.me.user.id ? `${member.name} (${t("team.you")})` : member.name }), h("span", { text: t(`role.${member.role}`) })), member.twoFactor ? h("span", { title: t("team.twofaOn") }, icon("security")) : null)),
      members.length > shown.length ? h("a", { class: "person", href: "/app/echipa" }, h("span", { class: "av", text: `+${members.length - shown.length}` }), h("div", { class: "grow" }, h("b", { text: t("common.seeAll") }))) : null,
    ),
    manager ? h("div", { class: "foot" }, h("a", { class: "btn small", href: "/app/echipa#invita" }, icon("userPlus"), t("home.invite"))) : null,
  ]);
}

function staffCard(staff) {
  const card = h("section", { class: "card", "aria-labelledby": "h-staff" }, cardHead(t("home.staff"), "staff", staff.total > 0 ? more("/app/angajati") : null));
  card.querySelector("h2").id = "h-staff";
  if (staff.total === 0) return append(card, [emptyState("staff", t("home.staffEmptyT"), t("home.staffEmpty"), downloadLink("btn small"))]);
  return append(card, [
    h(
      "ul",
      { class: "list" },
      staff.items.slice(0, 6).map((item) => h("li", {}, avatar(staffName(item.staffId), "sm"), h("div", { class: "grow" }, h("div", { class: "title", text: staffName(item.staffId) }), h("div", { class: "meta", text: [item.managerName ? t("home.staffBy", { name: item.managerName }) : null, fmtWhen(item.updatedAt)].filter(Boolean).join(" · ") })), h("span", { class: "chip mono", text: `v${item.version}` }))),
    ),
  ]);
}

function deviceRow(machine) {
  const os = osOf(machine.name, (machine.runnerCompanyIds ?? []).length > 0);
  return h("li", {}, h("span", { class: "os" }, icon(os.icon)), h("div", { class: "grow" }, h("div", { class: "title", text: machine.name }), h("div", { class: "meta", text: machine.online ? t("common.online") : seenText(machine.lastSeenAt) })), h("span", { class: `dot${machine.online ? " on" : ""}`, title: machine.online ? t("common.online") : t("common.offline") }));
}

function myDevicesCard() {
  const machines = state.me.environments ?? [];
  const card = h("section", { class: "card", "aria-labelledby": "h-mydevices" }, cardHead(t("home.myDevices"), "devices", machines.length > 0 ? more("/app/dispozitive") : null));
  card.querySelector("h2").id = "h-mydevices";
  if (machines.length === 0) return append(card, [emptyState("laptop", t("home.myDevicesEmptyT"), t("home.myDevicesEmpty"), downloadLink("btn small"))]);
  return append(card, [h("ul", { class: "list" }, machines.slice(0, 5).map(deviceRow))]);
}

// ---- Firma -----------------------------------------------------------------------------------

function createCompanyCard() {
  const name = h("input", { name: "company", required: true, maxlength: "80", placeholder: t("ph.company") });
  const create = h("button", { class: "btn loud", type: "submit", text: t("company.createButton") });
  const error = h("p", { class: "error", role: "alert" });
  const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("company.name"), name), h("div", { class: "row" }, create), error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(create, error, async () => {
      const created = await api("POST", "/v1/companies", { name: name.value.trim() });
      setCompany(created.id);
      await loadMe();
      // A new owner must turn on two-factor before using the company.
      if (state.me.twoFactor.gate !== "ok") {
        try {
          sessionStorage.setItem("zen.next", "/app/acasa");
        } catch {}
        return go("intra", { replace: true });
      }
      go("acasa");
    });
  });
  return h("section", { class: "card", id: "alta" }, cardHead(t("company.create"), "plus"), h("p", { class: "lede", text: t("company.createLead") }), form);
}

const DETAIL_FIELDS = ["legalName", "taxId", "registryNo", "billingEmail", "address", "city", "county", "country"];

function pageCompany(main, mine) {
  if (state.companyId === null) return noCompany(main);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols side-right" }, cardSkeleton(6), cardSkeleton(3))],
    () => overview(true),
    (data) => {
      const manager = isManager(data.role);
      const details = data.company.details ?? {};
      const name = h("input", { value: data.company.name, maxlength: "80", disabled: !manager, "aria-label": t("company.name") });
      const rename = h("button", { class: "btn primary", type: "submit", text: t("company.rename") });
      const renameError = h("p", { class: "error", role: "alert" });
      const renameForm = h("form", { class: "form", novalidate: true }, h("label", {}, t("company.name"), name), manager ? h("div", { class: "row" }, rename) : null, renameError);
      renameForm.addEventListener("submit", (event) => {
        event.preventDefault();
        act(rename, renameError, async () => {
          await api("PATCH", companyPath(), { name: name.value.trim() });
          await loadMe();
          state.overview = null;
          route();
        });
      });
      const inputs = Object.fromEntries(DETAIL_FIELDS.map((field) => [field, h("input", { value: details[field] ?? (field === "country" && LANG === "ro" ? "România" : ""), disabled: !manager, name: field, type: field === "billingEmail" ? "email" : "text", class: field === "taxId" || field === "registryNo" ? "mono" : null })]));
      const filled = DETAIL_FIELDS.filter((field) => details[field]).length;
      const save = h("button", { class: "btn primary", type: "submit", text: t("common.save") });
      const saveError = h("p", { class: "error", role: "alert" });
      const saved = h("p", { class: "ok-line", role: "status" });
      const detailsForm = h(
        "form",
        { class: "form", novalidate: true },
        h("div", { class: "form-grid" }, DETAIL_FIELDS.map((field) => h("label", { class: field === "address" || field === "legalName" ? "wide" : null }, t(`company.${field}`), inputs[field]))),
        manager ? h("div", { class: "row" }, save) : h("p", { class: "note" }, icon("lock"), h("span", { text: t("company.readOnly") })),
        saveError,
        saved,
      );
      detailsForm.addEventListener("submit", (event) => {
        event.preventDefault();
        saved.textContent = "";
        act(save, saveError, async () => {
          await api("PATCH", companyPath(), { details: Object.fromEntries(DETAIL_FIELDS.map((field) => [field, inputs[field].value.trim()])) });
          state.overview = null;
          saved.replaceChildren(icon("check"), t("common.saved"));
        });
      });
      const identity = h(
        "section",
        { class: "card" },
        h("div", { class: "mcard-top", style: "margin-bottom:18px" }, h("span", { class: "co-tile", style: "width:56px;height:56px;font-size:22px;border-radius:14px", text: initials(data.company.name) }), h("div", { class: "grow" }, h("b", { class: "staff-name", text: data.company.name }), h("span", { text: t("company.since", { n: data.members.total, role: t(`role.${data.role}`).toLowerCase() }) }))),
        renameForm,
      );
      append(main, [
        head(title(t("company.title"), t("company.titleAccent")), [h("span", { text: data.company.name }), h("span", { class: "dot-sep", text: planLine(data.plan) })]),
        h(
          "div",
          { class: "cols side-right" },
          h("section", { class: "card" }, cardHead(t("company.details"), "file", h("span", { class: "meta-r", text: t("company.filled", { n: filled }) })), h("p", { class: "lede prose", text: t("company.detailsLead") }), detailsForm),
          h("div", { class: "stack" }, identity, h("section", { class: "card" }, cardHead(t("company.createAnother"), "plus"), h("p", { class: "lede", text: t("company.createAnotherLead") }), h("details", { open: location.hash === "#alta" }, h("summary", { text: t("company.create") }), h("div", { class: "inner" }, createCompanyForm())))),
        ),
      ]);
    },
  );
}

/** The create form alone (inside another card). */
function createCompanyForm() {
  return createCompanyCard().querySelector("form");
}

// ---- Echipă ----------------------------------------------------------------------------------

function pageTeam(main, mine) {
  if (state.companyId === null) return noCompany(main);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols side-right" }, h("div", { class: "tiles" }, bones(4, "b-card card")), cardSkeleton(5))],
    () => api("GET", companyPath()),
    (data) => {
      const manager = isManager(data.role);
      const me = state.me.user.id;
      const owners = data.members.filter((m) => m.role === "owner").length;
      const cards = data.members.map((member) => {
        const error = h("span", { class: "error small" });
        const removable = manager && member.userId !== me && (member.role !== "owner" || data.role === "owner");
        const leave = member.userId === me && !(member.role === "owner" && owners === 1);
        let roleEl;
        if (!manager || member.userId === me || (member.role === "owner" && data.role !== "owner")) {
          roleEl = h("span", { class: `chip${member.role === "owner" ? " ink" : ""}`, text: t(`role.${member.role}`) });
        } else {
          const allowed = data.role === "owner" ? ["owner", "admin", "member", "guest"] : ["admin", "member", "guest"];
          roleEl = h("select", { class: "inline", "aria-label": `${t("team.role")} ${member.name}` }, allowed.map((role) => h("option", { value: role, text: t(`role.${role}`), selected: role === member.role })));
          roleEl.addEventListener("change", () =>
            act(null, error, async () => {
              await api("PATCH", companyPath(`/members/${encodeURIComponent(member.userId)}`), { role: roleEl.value });
              state.overview = null;
              route();
            }),
          );
        }
        const action =
          removable || leave
            ? confirmButton(leave ? t("team.leave") : t("common.remove"), (button) =>
                act(button, error, async () => {
                  await api("DELETE", companyPath(`/members/${encodeURIComponent(member.userId)}`));
                  if (leave) {
                    state.companyId = null;
                    await loadMe();
                    return go("acasa");
                  }
                  route();
                }),
              )
            : null;
        return h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, avatar(member.name, "lg"), h("div", { class: "grow" }, h("b", {}, member.name, member.userId === me ? h("span", { class: "muted", text: ` (${t("team.you")})` }) : null), h("span", { text: member.email }))),
          h(
            "div",
            { class: "mcard-facts" },
            h("span", { class: "state" }, h("span", { class: `dot${member.twoFactor ? " on" : ""}` }), member.twoFactor ? t("team.twofaOn") : t("team.twofaOff")),
            h("span", { text: t("team.since", { date: fmtDate(member.joinedAt) }) }),
            member.customRoleName ? h("a", { class: "chip", href: "/app/roluri", text: t("team.customRole", { name: member.customRoleName }) }) : null,
            member.scopedRoles > 0 ? h("span", { class: "chip", text: t("team.scopedRoles", { n: member.scopedRoles }) }) : null,
          ),
          h("div", { class: "mcard-foot" }, roleEl, h("span", {}, action, error)),
        );
      });
      append(main, [
        head(title(t("team.title"), t("team.titleAccent")), [h("span", { text: currentCompany()?.name ?? "" }), h("span", { class: "dot-sep", text: `${data.members.length} ${t("team.members").toLowerCase()}` })], can("echipa:vede") ? h("a", { class: "btn", href: "/app/roluri" }, icon("key"), t("team.roles")) : null),
        h(
          "div",
          { class: "cols side-right" },
          h("div", { class: "stack" }, h("div", { class: "tiles" }, cards), h("p", { class: "note prose" }, icon("team"), h("span", { text: t("team.roleHelp") }))),
          manager || can("echipa:creeaza") ? h("div", { class: "stack sticky" }, inviteCard(data.role), pendingCard(data.invites)) : h("section", { class: "card" }, emptyState("userPlus", t("team.invite"), t("team.inviteOnlyManagers"))),
        ),
      ]);
      if (location.hash === "#invita") document.getElementById("invita")?.querySelector("select, input")?.focus();
    },
  );
}

function roleOptions(myRole) {
  return ["member", "admin", "guest"].filter((role) => myRole === "owner" || role !== "owner").map((role) => h("option", { value: role, text: t(`role.${role}`) }));
}

function inviteCard(myRole) {
  // By link
  const linkRole = h("select", { "aria-label": t("team.role") }, roleOptions(myRole));
  const make = h("button", { class: "btn loud", type: "submit" }, icon("link"), t("team.inviteLinkMake"));
  const linkError = h("p", { class: "error", role: "alert" });
  const linkOut = h("div", {});
  const linkForm = h("form", { class: "form", novalidate: true }, h("p", { class: "lede", text: t("team.inviteLinkLead") }), h("label", {}, t("team.role"), linkRole), h("div", { class: "row" }, make), linkError, linkOut);
  linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    act(make, linkError, async () => {
      const created = await api("POST", companyPath("/invites"), { role: linkRole.value, lang: LANG });
      const field = h("input", { readonly: true, value: created.link, "aria-label": t("team.inviteLink"), "data-testid": "invite-link" });
      const copy = h("button", { class: "btn primary", type: "button" }, icon("copy"), t("common.copy"));
      copy.addEventListener("click", () => copyText(created.link, copy));
      linkOut.replaceChildren(h("div", { class: "copy-box" }, field, copy), h("p", { class: "note" }, icon("lock"), h("span", { text: t("team.inviteLinkOnce") })));
      field.select();
      refreshPending();
    });
  });
  // By e-mail
  const email = h("input", { type: "email", placeholder: t("ph.colleague"), "aria-label": t("team.email") });
  const emailRole = h("select", { "aria-label": t("team.role") }, roleOptions(myRole));
  const send = h("button", { class: "btn primary", type: "submit" }, icon("mail"), t("team.inviteSend"));
  const emailError = h("p", { class: "error", role: "alert" });
  const emailDone = h("p", { class: "ok-line", role: "status" });
  const emailForm = h("form", { class: "form", novalidate: true }, h("p", { class: "lede", text: t("team.inviteEmailLead") }), h("label", {}, t("team.email"), email), h("label", {}, t("team.role"), emailRole), h("div", { class: "row" }, send), emailError, emailDone);
  emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    emailDone.textContent = "";
    act(send, emailError, async () => {
      const address = email.value.trim();
      if (address === "") throw new ApiError(400, t("err.email"), null);
      await api("POST", companyPath("/invites"), { email: address, role: emailRole.value, lang: LANG });
      emailDone.replaceChildren(icon("check"), t("team.inviteSent", { email: address }));
      email.value = "";
      refreshPending();
    });
  });
  const panels = { link: linkForm, email: emailForm };
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const holder = h("div", {});
  const show = (which) => {
    for (const button of tabs.children) button.setAttribute("aria-selected", String(button.dataset.tab === which));
    holder.replaceChildren(panels[which]);
  };
  for (const [key, label] of [["link", t("team.inviteLink")], ["email", t("team.inviteEmail")]]) tabs.append(h("button", { type: "button", role: "tab", dataset: { tab: key }, text: label, onclick: () => show(key) }));
  show("link");
  return h("section", { class: "card", id: "invita" }, cardHead(t("team.invite"), "userPlus"), tabs, holder);
}

let pendingHolder = null;

function pendingList(invites) {
  if (invites.length === 0) return h("p", { class: "muted small", text: t("team.pendingNone") });
  return h(
    "ul",
    { class: "list" },
    invites.map((invite) => {
      const error = h("span", { class: "error small" });
      return h(
        "li",
        {},
        h("span", { class: "os", style: "width:34px;height:34px;border-radius:50%" }, icon(invite.email ? "mail" : "link")),
        h("div", { class: "grow" }, h("div", { class: "title", text: invite.email ?? t("team.pendingLink") }), h("div", { class: "meta", text: `${t(`role.${invite.role}`)} · ${fmtWhen(invite.createdAt)}` })),
        confirmButton(t("team.revoke"), (button) =>
          act(button, error, async () => {
            await api("DELETE", companyPath(`/invites/${encodeURIComponent(invite.id)}`));
            refreshPending();
          }),
        ),
        error,
      );
    }),
  );
}

function pendingCard(invites) {
  pendingHolder = h("div", {}, pendingList(invites));
  return h("section", { class: "card" }, cardHead(t("team.pending"), "clock"), pendingHolder);
}

async function refreshPending() {
  if (pendingHolder === null) return;
  try {
    const data = await api("GET", companyPath());
    pendingHolder.replaceChildren(pendingList(data.invites));
    state.overview = null;
  } catch {}
}

// ---- Dispozitive -----------------------------------------------------------------------------

function pageDevices(main, mine) {
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "tiles" }, bones(3, "b-card card")), h("div", { class: "bento", style: "margin-top:22px" }, cardSkeleton(3, { cls: "w2" }), cardSkeleton(3), cardSkeleton(4, { cls: "w2" }))],
    async () => {
      const [me, devices, sessions, data] = await Promise.all([loadMe(), api("GET", "/v1/me/devices"), api("GET", "/v1/me/sessions"), state.companyId === null ? null : overview(true)]);
      const prints = await Promise.all(devices.devices.map((device) => fingerprint(device.signPublicKey)));
      return { me, devices: devices.devices.map((device, index) => ({ ...device, fingerprint: prints[index] })), sessions: sessions.sessions, data };
    },
    ({ me, devices, sessions, data }) => {
      const companyName = (id) => me.companies.find((company) => company.id === id)?.name ?? "";
      const machines = me.environments.map((machine) => {
        const runner = (machine.runnerCompanyIds ?? []).length > 0;
        const os = osOf(machine.name, runner);
        return h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, h("span", { class: "os" }, icon(os.icon)), h("div", { class: "grow" }, h("b", { text: machine.name }), h("span", { text: [os.label, runner ? t("devices.runnerFor", { company: machine.runnerCompanyIds.map(companyName).join(", ") }) : null, (machine.runnerCompanyIds ?? []).length > 1 ? t("company.runnerMulti") : null].filter(Boolean).join(" · ") }))),
          h("div", { class: "mcard-facts" }, h("span", { class: "state" }, h("span", { class: `dot${machine.online ? " on" : ""}` }), machine.online ? t("common.online") : seenText(machine.lastSeenAt)), machine.aiAccount ? h("span", { text: machine.aiAccount.label }) : null),
        );
      });
      const live = devices.filter((device) => !device.revoked);
      const revoked = devices.length - live.length;
      const keys = h(
        "section",
        { class: "card w2" },
        cardHead(t("devices.keys"), "key"),
        h("p", { class: "lede prose", text: t("devices.keysLead") }),
        live.length === 0
          ? h("p", { class: "muted", text: t("devices.keysNone") })
          : h(
              "div",
              { class: "tiles", style: "margin-top:6px" },
              live.map((device) => {
                const approved = device.certifiedBy.length > 0;
                return h(
                  "div",
                  { class: "ap key-card", style: "min-height:0" },
                  h("div", { class: "ap-top" }, h("span", { class: "os", style: "width:30px;height:30px;border-radius:8px" }, icon(osOf(device.label).icon)), h("b", { text: device.label })),
                  h("div", { class: "fp", text: device.fingerprint }),
                  h("div", { class: "ap-m", text: `${fmtDate(device.createdAt)} · ${approved ? t("devices.keyApproved") : t("devices.keyFirst")}` }),
                  approved ? stamp(t("home.stampApproved")) : null,
                );
              }),
            ),
        revoked > 0 ? h("p", { class: "muted small", style: "margin-top:12px", text: t("devices.keyRevoked", { n: revoked }) }) : null,
        h("details", { style: "margin-top:16px" }, h("summary", { text: t("devices.approveHow") }), h("p", { class: "inner prose muted", text: t("devices.approveText") })),
      );
      const waiting = data === null ? [] : data.approvals.devices;
      const waitingCard = h(
        "section",
        { class: "card" },
        cardHead(t("devices.waiting"), "inbox"),
        waiting.length === 0
          ? h("div", { class: "ap-empty" }, stamp(t("home.stampApproved"), { big: true }), h("p", { text: t("devices.waitingNone") }))
          : h("div", { class: "aps" }, waiting.map((device) => approvalItem({ who: device.userName, kind: t("home.apDevice"), heading: t("home.apDeviceTitle", { device: device.deviceLabel, runner: device.runnerName }), metaMono: device.fingerprint, metaText: fmtWhen(device.reportedAt) }))),
        h("p", { class: "note" }, icon("alert"), h("span", { text: t("devices.waitingNote") })),
      );
      const sessionCards = sessions.map((session) => {
        const error = h("span", { class: "error small" });
        const os = osOf(session.label);
        return h(
          "li",
          {},
          h("span", { class: "os" }, icon(os.icon)),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title" }, session.label, session.current ? h("span", { class: "chip ink", style: "margin-left:8px", text: t("devices.sessionCurrent") }) : null),
            h("div", { class: "meta" }, [t(`devices.method.${session.method}`), session.twoFactor ? t("devices.with2fa") : null, t("devices.sessionUsed", { when: fmtWhen(session.lastUsedAt ?? session.createdAt) })].filter(Boolean).join(" · "), session.ip ? [" · ", h("span", { class: "mono", text: session.ip })] : null),
          ),
          confirmButton(t("devices.sessionEnd"), (button) =>
            act(button, error, async () => {
              await api("DELETE", `/v1/me/sessions/${encodeURIComponent(session.id)}`);
              if (session.current) {
                state.me = null;
                return go("intra", { replace: true });
              }
              route();
            }),
          ),
          error,
        );
      });
      const sessionsCard = h("section", { class: "card w2" }, cardHead(t("devices.sessions"), "globe", h("span", { class: "meta-r", text: String(sessions.length) })), h("ul", { class: "list" }, sessionCards));
      append(main, [
        head(title(t("devices.title"), t("devices.titleAccent")), me.user.email),
        h("h2", { class: "visually-hidden", text: t("devices.machines") }),
        me.environments.length === 0 ? h("section", { class: "card" }, emptyState("laptop", t("home.myDevicesEmptyT"), t("home.myDevicesEmpty"), downloadLink("btn primary"))) : h("div", { class: "tiles" }, machines),
        h("div", { class: "bento", style: "margin-top:var(--gap)" }, keys, waitingCard, sessionsCard, data === null ? null : runnerCard(data.runners)),
      ]);
    },
  );
}

// ---- Angajați AI -----------------------------------------------------------------------------

function sealCard() {
  return h("section", { class: "card dark" }, h("div", { class: "seal" }, h("span", { class: "os" }, icon("lock")), h("div", {}, h("h3", { text: t("staff.sealedT") }), h("p", { class: "prose", style: "margin:8px 0 0;color:#c9cfda", text: t("staff.sealed") }))));
}

function pageStaff(main, mine) {
  if (state.companyId === null) return noCompany(main);
  const role = currentCompany()?.role;
  if (role === "guest") {
    main.replaceChildren(head(title(t("staff.title"), t("staff.titleAccent"))), h("div", { class: "card" }, emptyState("lock", t("nav.staff"), t("staff.guest"))));
    return;
  }
  load(
    main,
    mine,
    [headSkeleton(), cardSkeleton(1), h("div", { class: "tiles", style: "margin-top:22px" }, bones(4, "b-card card"))],
    () => api("GET", companyPath("/staff/summary")),
    (data) => {
      const cards = data.staff.map((item) =>
        h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, avatar(staffName(item.staffId), "lg"), h("div", { class: "grow" }, h("b", { class: "staff-name", text: staffName(item.staffId) }), h("span", { class: "mono", text: item.staffId })), h("span", { class: "chip mono", text: `v${item.version}` })),
          h(
            "dl",
            { class: "runner-facts", style: "margin:0" },
            h("div", {}, h("dt", { text: t("staff.manager") }), h("dd", { text: item.managerName ?? t("staff.noManager") })),
            h("div", {}, h("dt", { text: t("staff.runsOn") }), h("dd", {}, item.runners.map((runner) => h("span", { class: "state", style: "margin-left:10px" }, h("span", { class: `dot${runner.online ? " on" : ""}` }), runner.name ?? runner.environmentId)))),
          ),
          h("div", { class: "meta", text: item.updatedByName ? t("staff.updatedBy", { when: fmtWhen(item.updatedAt), name: item.updatedByName }) : t("staff.updated", { when: fmtWhen(item.updatedAt) }) }),
        ),
      );
      append(main, [
        head(
          title(t("staff.title"), t("staff.titleAccent")),
          data.staff.length === 0
            ? t("staff.lead")
            : [h("span", { text: t("staff.count", { n: data.staff.length }) }), h("span", { class: "dot-sep", text: t("staff.lastChange", { when: fmtWhen(data.staff.map((item) => item.updatedAt).sort().at(-1)) }) })],
          downloadLink("btn"),
        ),
        sealCard(),
        data.staff.length === 0 ? h("section", { class: "card", style: "margin-top:var(--gap)" }, emptyState("staff", t("home.staffEmptyT"), t("staff.none"), downloadLink("btn primary"))) : h("div", { class: "tiles", style: "margin-top:var(--gap)" }, cards),
      ]);
    },
  );
}

// ---- Pachete ---------------------------------------------------------------------------------

function pagePacks(main, mine) {
  if (state.companyId === null) return noCompany(main);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "tiles" }, bones(3, "b-card card"))],
    () => api("GET", companyPath("/packs")),
    (data) => {
      const manager = isManager(currentCompany()?.role);
      const rows = data.status.filter((row) => !row.hidden);
      const cards = data.packs.map((pack) => {
        const mineRows = rows.filter((row) => row.packId === pack.packId);
        return h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, h("span", { class: "os" }, icon("packs")), h("div", { class: "grow" }, h("b", { class: "mono", style: "font-size:15px", text: pack.packId }), h("span", { text: t("packs.by", { name: pack.updatedByName, date: fmtDate(pack.updatedAt) }) })), h("span", { class: "chip mono", text: pack.version })),
          pack.enterprise ? h("div", {}, h("span", { class: "chip line" }, icon("lock"), t("packs.enterprise"))) : null,
          packHealth(pack, rows, true),
          mineRows.length > 0
            ? h(
                "ul",
                { class: "list" },
                mineRows.map((row) =>
                  h(
                    "li",
                    {},
                    h("span", { class: `dot${row.state === "failed" ? " bad" : row.state === "installing" ? "" : " on"}` }),
                    h("div", { class: "grow" }, h("div", { class: "title", text: row.environmentName }), h("div", { class: "meta" }, [row.userName, t(`packs.state.${row.state}`), fmtWhen(row.updatedAt)].join(" · "), row.version ? [" · ", h("span", { class: "mono", text: row.version })] : null)),
                  ),
                ),
              )
            : null,
        );
      });
      append(main, [
        head(title(t("packs.title"), t("packs.titleAccent")), t("packs.lead")),
        data.packs.length === 0 ? h("section", { class: "card" }, emptyState("packs", t("home.packsEmptyT"), t("packs.none"), downloadLink("btn primary"))) : h("div", { class: "tiles" }, cards),
        h("p", { class: "note prose" }, icon("key"), h("span", { text: t("packs.how") })),
        manager ? null : h("p", { class: "note prose" }, icon("lock"), h("span", { text: t("packs.mineOnly") })),
      ]);
    },
  );
}

// ---- Securitate ------------------------------------------------------------------------------

function pageSecurity(main, mine) {
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "bento" }, cardSkeleton(2), cardSkeleton(3), cardSkeleton(3), cardSkeleton(6, { cls: "full" }))],
    async () => {
      const manager = isManager(currentCompany()?.role);
      const [totp, passkeys, account, company] = await Promise.all([
        api("GET", "/v1/auth/totp"),
        api("GET", "/v1/me/passkeys"),
        api("GET", "/v1/me/audit"),
        manager ? api("GET", companyPath("/audit")) : Promise.resolve({ entries: [] }),
      ]);
      return { totp, passkeys: passkeys.passkeys, entries: [...account.entries.map((entry) => ({ ...entry, actorName: state.me.user.name })), ...company.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60) };
    },
    ({ totp, passkeys, entries }) => {
      append(main, [head(title(t("security.title"), t("security.titleAccent")), state.me.user.email, can("echipa:administreaza") ? h("a", { class: "btn", href: "/app/jurnal" }, icon("clock"), t("nav.journal")) : null), h("div", { class: "bento" }, accountCard(), twoFactorCard(totp), passkeysCard(passkeys), auditCard(entries))]);
      if (location.hash === "#jurnal") document.getElementById("jurnal")?.scrollIntoView();
    },
  );
}

function accountCard() {
  const name = h("input", { value: state.me.user.name, maxlength: "80", "aria-label": t("security.yourName") });
  const save = h("button", { class: "btn primary", type: "submit", text: t("common.save") });
  const error = h("p", { class: "error", role: "alert" });
  const done = h("p", { class: "ok-line", role: "status" });
  const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("security.yourName"), name), h("div", { class: "row" }, save), error, done);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    done.textContent = "";
    act(save, error, async () => {
      await api("PATCH", "/v1/me", { name: name.value.trim() });
      await loadMe();
      done.replaceChildren(icon("check"), t("common.saved"));
    });
  });
  const language = h("div", { class: "lang-row" }, h("div", { class: "grow" }, h("b", { text: t("lang.label") }), h("p", { class: "small muted", text: t("lang.lead") })), langSwitch());
  return h("section", { class: "card" }, cardHead(t("security.account"), "user"), h("div", { class: "mcard-top", style: "margin-bottom:16px" }, avatar(state.me.user.name, "lg"), h("div", { class: "grow" }, h("b", { text: state.me.user.name }), h("span", { text: state.me.user.email }))), form, language);
}

function twoFactorCard(totp) {
  const card = h("section", { class: "card" });
  const body = h("div", { class: "form" });
  const codeForm = (label, buttonText, path, onDone) => {
    const code = h("input", { class: "code", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", "aria-label": t("twofa.code") });
    const go = h("button", { class: "btn primary", type: "submit", text: buttonText });
    const error = h("p", { class: "error", role: "alert" });
    const form = h("form", { class: "form inner", novalidate: true }, h("p", { class: "muted small", style: "margin:0", text: label }), h("label", {}, t("twofa.code"), code), h("div", { class: "row" }, go), error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act(go, error, async () => onDone(await api("POST", path, { code: code.value.trim() })));
    });
    return form;
  };
  if (totp.enabled) {
    const out = h("div", {});
    body.append(
      h("div", { class: "row" }, h("span", { class: "chip ink" }, icon("check"), t("security.twofaOn")), h("span", { class: "small muted", text: t("security.codesLeft", { n: totp.recoveryCodesLeft }) })),
      h("details", {}, h("summary", { text: t("security.newCodes") }), codeForm(t("security.newCodesLead"), t("security.newCodes"), "/v1/auth/totp/recovery-codes", (result) => out.replaceChildren(recoveryCodesBlock(result.recoveryCodes)))),
      out,
      totp.required ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("security.twofaRequired") })) : h("details", {}, h("summary", { text: t("security.disable") }), codeForm(t("security.disableLead"), t("security.disable"), "/v1/auth/totp/disable", () => route())),
    );
  } else {
    const start = h("button", { class: "btn loud", type: "button", text: t("twofa.enable") });
    start.addEventListener("click", () =>
      body.replaceChildren(
        totpSetupForm((codes) => {
          body.replaceChildren(h("p", { class: "lede", text: t("twofa.codesLead") }), recoveryCodesBlock(codes));
          loadMe().catch(() => undefined);
        }),
      ),
    );
    body.append(h("div", { class: "row" }, h("span", { class: "chip line", text: t("security.twofaOff") }), h("span", { class: "small muted", text: t("security.twofaOptional") })), h("div", { class: "row" }, start));
  }
  return append(card, [cardHead(t("security.twofa"), "security"), body]);
}

function passkeysCard(passkeys) {
  const label = h("input", { placeholder: t("security.passkeyName"), maxlength: "120", "aria-label": t("security.passkeyName") });
  const add = h("button", { class: "btn primary", type: "submit" }, icon("plus"), t("security.passkeyAdd"));
  const error = h("p", { class: "error", role: "alert" });
  const done = h("p", { class: "ok-line", role: "status" });
  const form = h("form", { class: "form", novalidate: true, style: "margin-top:14px" }, h("label", {}, t("security.passkeyName"), label), h("div", { class: "row" }, add), error, done);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Open the tab inside the click, so the browser does not block it; then point it at the page.
    const tab = window.open("about:blank", "_blank");
    act(add, error, async () => {
      const started = await api("POST", "/v1/me/passkeys/register", { lang: LANG, label: label.value.trim() || "Passkey" });
      if (tab) {
        tab.opener = null;
        tab.location.href = started.url;
      } else window.location.assign(started.url);
      done.textContent = t("security.passkeyOpened");
      window.addEventListener("focus", () => route(), { once: true });
    }).then(() => {
      if (error.textContent && tab) tab.close();
    });
  });
  return h(
    "section",
    { class: "card" },
    cardHead(t("security.passkeys"), "key"),
    h("p", { class: "lede", text: t("security.passkeysLead") }),
    passkeys.length === 0
      ? h("p", { class: "muted small", text: t("security.passkeysNone") })
      : h(
          "ul",
          { class: "list" },
          passkeys.map((passkey) => {
            const rowError = h("span", { class: "error small" });
            return h(
              "li",
              {},
              h("span", { class: "os", style: "width:34px;height:34px" }, icon("key")),
              h("div", { class: "grow" }, h("div", { class: "title", text: passkey.label }), h("div", { class: "meta", text: [fmtDate(passkey.createdAt), passkey.lastUsedAt ? t("security.passkeyLastUsed", { when: fmtWhen(passkey.lastUsedAt) }) : null, passkey.backedUp ? t("security.passkeySynced") : null].filter(Boolean).join(" · ") })),
              confirmButton(t("common.remove"), (button) =>
                act(button, rowError, async () => {
                  await api("DELETE", `/v1/me/passkeys/${encodeURIComponent(passkey.id)}`);
                  route();
                }),
              ),
              rowError,
            );
          }),
        ),
    form,
  );
}

function auditCard(entries) {
  return h(
    "section",
    { class: "card full", id: "jurnal" },
    cardHead(t("security.audit"), "clock", h("span", { class: "meta-r", text: String(entries.length) })),
    entries.length === 0
      ? h("p", { class: "muted", text: t("security.auditNone") })
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "stackable" },
            h("thead", {}, h("tr", {}, [t("security.auditWhen"), t("security.auditWho"), t("security.auditWhat"), t("security.auditDetail")].map((label) => h("th", { text: label })))),
            h(
              "tbody",
              {},
              entries.map((entry) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "first small", style: "white-space:nowrap", text: fmtWhen(entry.createdAt) }),
                  h("td", { class: "small" }, h("span", { class: "state" }, avatar(entry.actorName ?? "?", "sm"), entry.actorName ?? "")),
                  h("td", {}, h("span", { class: "state" }, icon(AUDIT_ICONS[entry.action.split(".")[0]] ?? "activity"), auditLabel(entry.action))),
                  h("td", { class: "small muted", lang: "en", text: entry.detail }),
                ),
              ),
            ),
          ),
        ),
  );
}

// ---- Roles (v9) --------------------------------------------------------------------------------

const RESOURCES = ["chats", "memorie", "pachete", "angajati", "facturare", "echipa", "dispozitive"];
const ACTIONS = ["vede", "creeaza", "aproba", "trimite", "administreaza"];
const EXTRAS = ["chats:urmareste", "chats:urmareste-toate"];

/** The permission grid: resources down, actions across, the two server-follow switches under it. */
function permissionGrid(selected, editable) {
  const chosen = new Set(selected);
  const box = (permission) => {
    const input = h("input", { type: "checkbox", checked: chosen.has(permission), disabled: !editable, "aria-label": permission, dataset: { perm: permission } });
    return input;
  };
  const table = h(
    "table",
    { class: "perm-grid" },
    h("thead", {}, h("tr", {}, h("th", { text: "" }), ACTIONS.map((action) => h("th", { scope: "col", text: t(`act.${action}`) })))),
    h(
      "tbody",
      {},
      RESOURCES.map((resource) => h("tr", {}, h("th", { scope: "row", text: t(`res.${resource}`) }), ACTIONS.map((action) => h("td", {}, box(`${resource}:${action}`))))),
    ),
  );
  const extras = h(
    "div",
    { class: "stack perm-extras" },
    h("b", { class: "small", text: t("roles.extras") }),
    EXTRAS.map((permission) => h("label", { class: "check" }, box(permission), h("span", { text: t(`perm.${permission}`) }))),
  );
  const holder = h("div", { class: "stack" }, h("div", { class: "table-wrap" }, table), extras);
  holder.value = () => [...holder.querySelectorAll("input[data-perm]")].filter((input) => input.checked).map((input) => input.dataset.perm);
  return holder;
}

function roleEditor(role, editable, done) {
  const builtin = role !== null && role.builtin !== null;
  const fixed = role !== null && (role.builtin === "owner" || role.builtin === "admin");
  const name = h("input", { value: role?.name ?? "", maxlength: "48", disabled: builtin || !editable, "aria-label": t("roles.name") });
  const description = h("input", { value: role?.description ?? "", maxlength: "200", disabled: builtin || !editable, "aria-label": t("roles.description") });
  const grid = permissionGrid(fixed ? [...RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}`)), ...EXTRAS] : (role?.permissions ?? ["chats:vede"]), editable && !fixed);
  const error = h("p", { class: "error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, icon("check"), t("roles.save"));
  const form = h(
    "form",
    { class: "form", novalidate: true },
    fixed ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("roles.all") })) : null,
    builtin ? null : h("label", {}, t("roles.name"), name),
    builtin ? null : h("label", {}, t("roles.description"), description),
    grid,
    editable && !fixed
      ? h(
          "div",
          { class: "row" },
          save,
          role === null
            ? null
            : confirmButton(builtin ? t("roles.reset") : t("roles.delete"), (button) =>
                act(button, error, async () => {
                  await api("DELETE", companyPath(`/roles/${encodeURIComponent(role.id)}`));
                  done();
                }),
              ),
        )
      : null,
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(save, error, async () => {
      const body = builtin ? { permissions: grid.value() } : { name: name.value.trim(), description: description.value.trim(), permissions: grid.value() };
      if (role === null) await api("POST", companyPath("/roles"), body);
      else await api("PUT", companyPath(`/roles/${encodeURIComponent(role.id)}`), body);
      state.access = null;
      done();
    });
  });
  return h("section", { class: "card", id: "editor" }, cardHead(role === null ? t("roles.new") : role.name, "key"), form);
}

function scopeLabel(data, grant) {
  if (grant.kind === "team") return t("roles.team", { name: data.teams.find((team) => team.id === grant.id)?.name ?? grant.id });
  return t("roles.project", { name: data.projects.find((project) => project.id === grant.id)?.name ?? grant.id });
}

function assignmentsCard(data) {
  const custom = data.roles.filter((role) => role.custom);
  const roleName = (id) => data.roles.find((role) => role.id === id)?.name ?? id;
  const rows = data.members.map((member) => {
    const error = h("span", { class: "error small" });
    const full = member.role === "owner" || member.role === "admin";
    const save = (customRoleId, scoped) =>
      act(null, error, async () => {
        await api("PUT", companyPath(`/members/${encodeURIComponent(member.userId)}/access`), { customRoleId, scoped });
        state.access = null;
        route();
      });
    let customEl;
    let scopedEl;
    if (full) {
      customEl = h("span", { class: "muted small", text: t("roles.fullAccess") });
      scopedEl = h("span", { text: "" });
    } else if (!data.canEdit) {
      customEl = h("span", { class: "chip", text: member.customRoleId === null ? t(`role.${member.role}`) : roleName(member.customRoleId) });
      scopedEl = h("span", { class: "small", text: member.scoped.map((grant) => `${roleName(grant.roleId)} ${t("roles.scopeOn", { scope: scopeLabel(data, grant) })}`).join(", ") });
    } else {
      customEl = h("select", { class: "inline", "aria-label": `${t("roles.customRole")} ${member.name}` }, h("option", { value: "", text: t("roles.none") }), custom.map((role) => h("option", { value: role.id, text: role.name, selected: role.id === member.customRoleId })));
      customEl.addEventListener("change", () => save(customEl.value === "" ? null : customEl.value, member.scoped));
      const scopes = [...data.teams.map((team) => ({ kind: "team", id: team.id, label: t("roles.team", { name: team.name }) })), ...data.projects.map((project) => ({ kind: "project", id: project.id, label: t("roles.project", { name: project.name }) }))];
      const pickRole = h("select", { class: "inline", "aria-label": t("roles.customRole") }, custom.map((role) => h("option", { value: role.id, text: role.name })));
      const pickScope = h("select", { class: "inline", "aria-label": t("roles.scoped") }, scopes.map((scope) => h("option", { value: `${scope.kind}:${scope.id}`, text: scope.label })));
      const add = h("button", { class: "btn small", type: "button", disabled: custom.length === 0 || scopes.length === 0 }, icon("plus"), t("roles.addScoped"));
      add.addEventListener("click", () => {
        const [kind, ...rest] = pickScope.value.split(":");
        save(member.customRoleId, [...member.scoped, { roleId: pickRole.value, kind, id: rest.join(":") }]);
      });
      scopedEl = h(
        "div",
        { class: "stack" },
        member.scoped.map((grant, index) =>
          h("span", { class: "chip" }, `${roleName(grant.roleId)} ${t("roles.scopeOn", { scope: scopeLabel(data, grant) })}`, h("button", { class: "icon-btn", type: "button", "aria-label": t("common.remove"), text: "×", onclick: () => save(member.customRoleId, member.scoped.filter((_, other) => other !== index)) })),
        ),
        h("div", { class: "row" }, pickRole, pickScope, add),
      );
    }
    return h("tr", {}, h("td", { class: "first" }, h("span", { class: "state" }, avatar(member.name, "sm"), h("span", {}, h("b", { text: member.name }), h("br"), h("span", { class: "small muted", text: member.email })))), h("td", {}, h("span", { class: `chip${member.role === "owner" ? " ink" : ""}`, text: t(`role.${member.role}`) })), h("td", {}, customEl), h("td", {}, scopedEl, error));
  });
  return h(
    "section",
    { class: "card full" },
    cardHead(t("roles.whoHas"), "team"),
    h("div", { class: "table-wrap" }, h("table", { class: "stackable" }, h("thead", {}, h("tr", {}, [t("journal.who"), t("roles.base"), t("roles.customRole"), t("roles.scoped")].map((label) => h("th", { text: label })))), h("tbody", {}, rows))),
  );
}

function scopesCard(data) {
  const teamName = h("input", { maxlength: "60", placeholder: t("ph.team"), "aria-label": t("roles.newTeam") });
  const teamError = h("p", { class: "error", role: "alert" });
  const addTeam = h("button", { class: "btn small", type: "submit" }, icon("plus"), t("roles.addTeam"));
  const teamForm = h("form", { class: "form", novalidate: true }, h("label", {}, t("roles.newTeam"), teamName), h("div", { class: "row" }, addTeam), teamError);
  teamForm.addEventListener("submit", (event) => {
    event.preventDefault();
    act(addTeam, teamError, async () => {
      await api("POST", companyPath("/teams"), { name: teamName.value.trim() });
      route();
    });
  });
  const projectId = h("input", { maxlength: "100", placeholder: t("ph.projectId"), "aria-label": t("roles.projectId") });
  const projectName = h("input", { maxlength: "80", placeholder: t("ph.projectName"), "aria-label": t("roles.projectName") });
  const projectTeam = h("select", { "aria-label": t("roles.projectTeam") }, h("option", { value: "", text: t("roles.noTeam") }), data.teams.map((team) => h("option", { value: team.id, text: team.name })));
  const projectError = h("p", { class: "error", role: "alert" });
  const addProject = h("button", { class: "btn small", type: "submit" }, icon("plus"), t("roles.addProject"));
  const projectForm = h("form", { class: "form", novalidate: true }, h("div", { class: "form-grid" }, h("label", {}, t("roles.projectId"), projectId), h("label", {}, t("roles.projectName"), projectName), h("label", {}, t("roles.projectTeam"), projectTeam)), h("div", { class: "row" }, addProject), projectError);
  projectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    act(addProject, projectError, async () => {
      await api("PUT", companyPath(`/projects/${encodeURIComponent(projectId.value.trim())}`), { name: projectName.value.trim(), teamId: projectTeam.value || null });
      route();
    });
  });
  const list = h(
    "ul",
    { class: "list" },
    data.teams.map((team) => h("li", {}, h("span", { class: "state" }, icon("team"), h("b", { text: team.name })), h("span", { class: "small muted", text: data.projects.filter((project) => project.teamId === team.id).map((project) => project.name).join(", ") }))),
    data.projects.filter((project) => project.teamId === null).map((project) => h("li", {}, h("span", { class: "state" }, icon("file"), h("b", { text: project.name })), h("span", { class: "small muted mono", text: project.id }))),
  );
  return h("section", { class: "card" }, cardHead(t("roles.scopes"), "file"), h("p", { class: "lede", text: t("roles.scopesLead") }), list, data.canEdit ? teamForm : null, data.canEdit ? projectForm : null);
}

function pageRoles(main, mine) {
  if (state.companyId === null) return noCompany(main);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols side-right" }, h("div", { class: "tiles" }, bones(4, "b-card card")), cardSkeleton(8))],
    () => api("GET", companyPath("/roles")),
    (data) => {
      const editorHolder = h("div", { class: "stack sticky" });
      const open = (role) => {
        editorHolder.replaceChildren(roleEditor(role, data.canEdit, () => route()));
        editorHolder.scrollIntoView({ block: "nearest" });
      };
      const cards = data.roles.map((role) =>
        h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, h("span", { class: "os" }, icon(role.custom ? "key" : "lock")), h("div", { class: "grow" }, h("b", { text: role.builtin ? t(`role.${role.builtin}`) : role.name }), h("span", { text: role.custom ? (role.description || t("roles.custom")) : t("roles.builtin") }))),
          h("div", { class: "mcard-facts" }, h("span", { text: role.memberCount === 1 ? t("roles.person") : t("roles.people", { n: role.memberCount }) }), h("span", { text: role.builtin === "owner" || role.builtin === "admin" ? t("roles.fullAccess") : `${role.permissions.length} / ${RESOURCES.length * ACTIONS.length + EXTRAS.length}` })),
          h("div", { class: "mcard-foot" }, h("span", {}), h("button", { class: "btn small", type: "button", onclick: () => open(role) }, data.canEdit && role.builtin !== "owner" && role.builtin !== "admin" ? t("roles.edit") : t("common.seeAll"))),
        ),
      );
      append(main, [
        head(title(t("roles.title"), t("roles.titleAccent")), t("roles.sub"), data.canEdit ? h("button", { class: "btn loud", type: "button", onclick: () => open(null) }, icon("plus"), t("roles.new")) : null),
        h("div", { class: "cols side-right" }, h("div", { class: "stack" }, h("p", { class: "note prose" }, icon("key"), h("span", { text: t("roles.lead") })), h("div", { class: "tiles" }, cards), h("p", { class: "note prose" }, icon("staff"), h("span", { text: t("roles.agentsNote") }))), editorHolder),
        assignmentsCard(data),
        scopesCard(data),
      ]);
      if (!data.canEdit) editorHolder.append(h("section", { class: "card" }, emptyState("lock", t("nav.roles"), t("roles.onlyManagers"))));
      else open(data.roles.find((role) => role.custom) ?? data.roles.find((role) => role.id === "member"));
    },
  );
}

// ---- Security journal (v9) ---------------------------------------------------------------------

function saveFile(filename, contentType, body) {
  const url = URL.createObjectURL(new Blob([body], { type: contentType }));
  const link = h("a", { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function journalRows(events) {
  return events.map((event) =>
    h(
      "tr",
      {},
      h("td", { class: "first small", style: "white-space:nowrap", text: fmtWhen(event.ts) }),
      h("td", { class: "small" }, h("span", { class: "state" }, avatar(event.actorName ?? "?", "sm"), h("span", {}, event.actorName ?? "-", h("br"), h("span", { class: "muted", text: event.actorEmail ?? "" })))),
      h("td", {}, h("span", { class: "state" }, icon(AUDIT_ICONS[event.action.split(".")[0]] ?? "activity"), auditLabel(event.action)), h("br"), h("span", { class: "small muted mono", text: event.action })),
      h("td", { class: "small mono" }, event.ip ?? "-", h("br"), h("span", { class: "muted", title: event.userAgent ?? "", text: event.deviceId ? `${t("journal.device")} ${event.deviceId.slice(0, 20)}` : "" })),
      h("td", { class: "small muted", lang: "en", text: [event.detail?.summary, event.target].filter(Boolean).join(" · ") }),
      h("td", { class: "small mono muted", title: event.hash, text: `#${event.chainSeq} ${event.hash.slice(0, 10)}` }),
    ),
  );
}

function verifyCard() {
  const out = h("div", { class: "stack", role: "status" });
  const button = h("button", { class: "btn primary", type: "button" }, icon("checkCircle"), t("journal.verify"));
  const error = h("p", { class: "error", role: "alert" });
  button.addEventListener("click", () =>
    act(button, error, async () => {
      const result = await api("GET", companyPath("/security/log/verify"));
      out.replaceChildren(
        h("p", { class: result.ok ? "ok-line" : "error" }, icon(result.ok ? "check" : "alert"), result.ok ? t("journal.intact", { n: fmtNum(result.checked), hash: (result.head ?? "-").slice(0, 16) }) : t("journal.broken", { n: result.brokenAt, reason: result.reason })),
        h("p", { class: "small muted", text: t("journal.anchors", { n: result.anchors.length }) }),
        result.anchors.length ? h("ul", { class: "list small mono" }, result.anchors.slice(-5).reverse().map((anchor) => h("li", { text: `${anchor.day} #${anchor.headSeq} ${anchor.headHash.slice(0, 24)}` }))) : null,
      );
    }),
  );
  return h("section", { class: "card" }, cardHead(t("journal.verify"), "checkCircle"), h("p", { class: "lede", text: t("journal.verifyLead") }), h("div", { class: "row" }, button), error, out);
}

function siemCard(siem) {
  const manager = isManager(currentCompany()?.role);
  const url = h("input", { type: "url", value: siem.url ?? "", placeholder: t("ph.siem"), "aria-label": t("journal.siemUrl"), disabled: !manager });
  const secret = h("input", { type: "password", autocomplete: "off", "aria-label": t("journal.siemSecret"), disabled: !manager });
  const error = h("p", { class: "error", role: "alert" });
  const out = h("p", { class: "ok-line", role: "status" });
  const status = h("p", { class: "small muted", text: siem.lastAt ? t("journal.siemStatus", { status: siem.lastStatus, when: fmtWhen(siem.lastAt) }) + (siem.lastError ? ` · ${siem.lastError}` : "") : t("journal.siemNever") });
  const save = h("button", { class: "btn primary", type: "submit" }, icon("forward"), t("journal.siemSave"));
  const form = h("form", { class: "form", novalidate: true }, h("p", { class: "lede", text: t("journal.siemLead") }), h("label", {}, t("journal.siemUrl"), url), h("label", {}, t("journal.siemSecret"), secret), manager ? h("div", { class: "row" }, save, siem.configured ? h("button", { class: "btn", type: "button", onclick: (event) => act(event.currentTarget, error, async () => { const answer = await api("POST", companyPath("/security/siem/test")); status.textContent = t("journal.siemStatus", { status: answer.lastStatus ?? "-", when: fmtWhen(answer.lastAt) }); }) }, t("journal.siemTest")) : null, siem.configured ? confirmButton(t("journal.siemRemove"), (button) => act(button, error, async () => { await api("DELETE", companyPath("/security/siem")); route(); })) : null) : null, status, error, out);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(save, error, async () => {
      const answer = await api("PUT", companyPath("/security/siem"), { url: url.value.trim(), ...(secret.value ? { secret: secret.value } : {}) });
      secret.value = "";
      out.textContent = answer.secret ? t("journal.siemSecretOnce", { secret: answer.secret }) : t("roles.saved");
    });
  });
  return h("section", { class: "card" }, cardHead(t("journal.siem"), "forward"), form);
}

function pageJournal(main, mine) {
  if (state.companyId === null) return noCompany(main);
  const filters = { actor: "", action: "", from: "", to: "" };
  const query = (extra = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
    return params.toString();
  };
  load(
    main,
    mine,
    [headSkeleton(), cardSkeleton(8, { cls: "full" })],
    async () => {
      const [log, siem] = await Promise.all([api("GET", companyPath(`/security/log?limit=100`)), api("GET", companyPath("/security/siem"))]);
      return { log, siem };
    },
    ({ log, siem }) => {
      const tbody = h("tbody", {}, journalRows(log.events));
      const empty = h("p", { class: "muted", text: t("journal.none"), hidden: log.events.length > 0 });
      let next = log.next;
      const moreButton = h("button", { class: "btn", type: "button", hidden: next === null }, t("journal.more"));
      const error = h("p", { class: "error", role: "alert" });
      const person = h("select", { "aria-label": t("journal.person") }, h("option", { value: "", text: t("journal.anyone") }), log.people.map((p) => h("option", { value: p.userId, text: `${p.name} (${p.email})` })));
      const action = h("select", { "aria-label": t("journal.action") }, h("option", { value: "", text: t("journal.anyAction") }), [...new Set(log.actions.map((a) => a.split(".")[0]))].map((group) => h("option", { value: group, text: `${group}.*` })), log.actions.map((a) => h("option", { value: a, text: `${auditLabel(a)} (${a})` })));
      const from = h("input", { type: "date", "aria-label": t("journal.from") });
      const to = h("input", { type: "date", "aria-label": t("journal.to") });
      const search = h("button", { class: "btn primary", type: "submit" }, t("journal.search"));
      const form = h("form", { class: "form", novalidate: true }, h("div", { class: "form-grid" }, h("label", {}, t("journal.person"), person), h("label", {}, t("journal.action"), action), h("label", {}, t("journal.from"), from), h("label", {}, t("journal.to"), to)), h("div", { class: "row" }, search, h("button", { class: "btn", type: "button", onclick: (event) => exportAs(event.currentTarget, "csv") }, icon("download"), `${t("journal.export")} CSV`), h("button", { class: "btn", type: "button", onclick: (event) => exportAs(event.currentTarget, "json") }, icon("download"), `${t("journal.export")} JSON`)), error);
      const exportAs = (button, format) =>
        act(button, error, async () => {
          const file = await api("GET", companyPath(`/security/log/export?${query({ format })}`));
          saveFile(file.filename, file.contentType, file.body);
        });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        Object.assign(filters, { actor: person.value, action: action.value, from: from.value, to: to.value });
        act(search, error, async () => {
          const found = await api("GET", companyPath(`/security/log?${query({ limit: 100 })}`));
          tbody.replaceChildren(...journalRows(found.events));
          empty.hidden = found.events.length > 0;
          next = found.next;
          moreButton.hidden = next === null;
        });
      });
      moreButton.addEventListener("click", () =>
        act(moreButton, error, async () => {
          const found = await api("GET", companyPath(`/security/log?${query({ limit: 100, before: next })}`));
          tbody.append(...journalRows(found.events));
          next = found.next;
          moreButton.hidden = next === null;
        }),
      );
      append(main, [
        head(title(t("journal.title"), t("journal.titleAccent")), t("journal.sub")),
        h("section", { class: "card full" }, form),
        h("section", { class: "card full", id: "jurnal" }, h("div", { class: "table-wrap" }, h("table", { class: "stackable" }, h("thead", {}, h("tr", {}, [t("journal.when"), t("journal.who"), t("journal.what"), t("journal.where"), t("journal.detail"), "hash"].map((label) => h("th", { text: label })))), tbody)), empty, h("div", { class: "row" }, moreButton)),
        h("div", { class: "bento" }, verifyCard(), siemCard(siem)),
      ]);
    },
  );
}

// ---- Cifre (only for the hub operator: HUB_STATS_EMAILS) ---------------------------------------

const sum = (values) => values.reduce((a, b) => a + b, 0);
let countryNames = null;
function countryName(code) {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return t("stats.countryUnknown");
  try {
    if (countryNames?.lang !== LANG) countryNames = { lang: LANG, names: new Intl.DisplayNames([LANG], { type: "region" }) };
    return countryNames.names.of(code) ?? code;
  } catch {
    return code;
  }
}

function statsSkeleton() {
  return [
    h("section", { class: "home-art art morning" }, headSkeleton(), h("div", { class: "kpis" }, bones(4, "b-kpi"))),
    h("div", { class: "bento" }, cardSkeleton(0, { cls: "w2", chart: true }), cardSkeleton(5), cardSkeleton(0, { cls: "w2", chart: true }), cardSkeleton(4), cardSkeleton(2, { cls: "w2" }), cardSkeleton(0, { chart: true })),
  ];
}

function statsKpi(label, iconName, value, sub, series) {
  return h(
    "div",
    { class: "kpi" },
    h("div", { class: "kpi-top" }, label, icon(iconName)),
    h("div", { class: "kpi-val num", text: value }),
    h("div", { class: "kpi-sub", text: sub }),
    series && series.length > 1 ? sparkline(series, `${label}: ${series.join(", ")}`) : null,
  );
}

function statsMissing(part) {
  return part.reason === "not_configured"
    ? emptyState("key", t("stats.notConfiguredT"), t("stats.notConfigured"))
    : emptyState("alert", t("stats.unavailableT"), t("stats.unavailable"), h("button", { class: "btn small", type: "button", text: t("common.retry"), onclick: () => route() }));
}

const statRow = (items) =>
  h("div", { class: "stats" }, items.map(([n, label]) => h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(n) }), h("div", { class: "l", text: label }))));

function downloadsCard(releases) {
  const card = h("section", { class: "card w2", "aria-labelledby": "h-downloads" }, cardHead(t("stats.downloads"), "download"));
  card.querySelector("h2").id = "h-downloads";
  if (!releases.ok) return append(card, [statsMissing(releases)]);
  const days = releases.data.downloads;
  const total = sum(days.map((day) => day.total));
  if (total === 0) return append(card, [emptyState("download", t("stats.downloadsNoneT"), t("stats.downloadsNone"))]);
  const byFormat = new Map(releases.data.downloadsByFormat.map((item) => [item.format, item.n]));
  return append(card, [
    areaChart(days, (day) => day.total, t("stats.downloadsUnit")),
    statRow([
      [byFormat.get("exe") ?? 0, t("stats.fmtExe")],
      [byFormat.get("appimage") ?? 0, t("stats.fmtAppImage")],
      [byFormat.get("deb") ?? 0, t("stats.fmtDeb")],
      [total, t("stats.total")],
    ]),
    h("p", { class: "note" }, icon("lock"), h("span", { text: t("stats.downloadsNote") })),
  ]);
}

function countriesCard(releases) {
  const card = h("section", { class: "card" }, cardHead(t("stats.countries"), "globe"));
  if (!releases.ok) return append(card, [statsMissing(releases)]);
  const rows = releases.data.downloadsByCountry.slice(0, 8);
  if (rows.length === 0) return append(card, [h("p", { class: "muted", text: t("stats.countriesNone") })]);
  return append(card, [
    h(
      "ul",
      { class: "list" },
      rows.map((row) => h("li", {}, h("div", { class: "grow", text: countryName(row.country) }), h("b", { class: "num", text: fmtNum(row.n) }))),
    ),
  ]);
}

function activeCard(releases) {
  const card = h("section", { class: "card w2" }, cardHead(t("stats.active"), "activity"));
  if (!releases.ok) return append(card, [statsMissing(releases)]);
  const days = releases.data.active;
  const checks = releases.data.checks;
  const today = days.at(-1);
  const body =
    sum(checks.map((day) => day.total)) === 0
      ? [emptyState("activity", t("stats.activeNoneT"), t("stats.activeNone"))]
      : [
          areaChart(days, (day) => day.total, t("stats.activeUnit")),
          statRow([
            [today.win, t("stats.osWin")],
            [today.linux, t("stats.osLinux")],
            [checks.at(-1).total, t("stats.checksToday")],
          ]),
        ];
  return append(card, [...body, h("p", { class: "note" }, icon("clock"), h("span", { text: t("stats.activeNote", { n: releases.data.checksPerDay }) }))]);
}

function versionsCard(releases) {
  const card = h("section", { class: "card" }, cardHead(t("stats.versions"), "packs"));
  if (!releases.ok) return append(card, [statsMissing(releases)]);
  const rows = releases.data.updatesByVersion;
  if (rows.length === 0) return append(card, [h("p", { class: "muted", text: t("stats.versionsNone") }), h("p", { class: "note" }, icon("lock"), h("span", { text: t("stats.versionsNote") }))]);
  return append(card, [
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, [t("stats.version"), t("stats.osWin"), t("stats.osLinux")].map((label) => h("th", { text: label })))),
        h("tbody", {}, rows.map((row) => h("tr", {}, h("td", { class: "mono", text: row.version }), h("td", { class: "num", text: fmtNum(row.win) }), h("td", { class: "num", text: fmtNum(row.linux) })))),
      ),
    ),
    h("p", { class: "note" }, icon("lock"), h("span", { text: t("stats.versionsNote") })),
  ]);
}

function hubCard(hub) {
  const week = hub.newThisWeek;
  const item = (n, label, added) => h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(n) }), h("div", { class: "l", text: label }), h("div", { class: "l", text: added > 0 ? t("stats.newWeek", { n: fmtNum(added) }) : t("stats.newWeekNone") }));
  return h(
    "section",
    { class: "card w2" },
    cardHead(t("stats.hub"), "server"),
    h("div", { class: "stats", style: "margin-top:0;padding-top:0;border-top:0" }, item(hub.accounts, t("stats.accounts"), week.accounts), item(hub.companies, t("stats.companies"), week.companies), item(hub.members, t("stats.members"), week.members), item(hub.devices, t("stats.devices"), week.devices)),
    h("p", { class: "note" }, icon("lock"), h("span", { text: t("stats.hubNote") })),
  );
}

function landingCard(landing) {
  const card = h("section", { class: "card" }, cardHead(t("stats.landing"), "globe"));
  if (!landing.ok) return append(card, [statsMissing(landing)]);
  const days = landing.data.days;
  const visits = sum(days.map((day) => day.visits));
  if (visits === 0) return append(card, [emptyState("globe", t("stats.landingNoneT"), t("stats.landingNone"))]);
  return append(card, [areaChart(days, (day) => day.visits, t("stats.visitsUnit")), statRow([[visits, t("stats.visits")], [sum(days.map((day) => day.views)), t("stats.views")]])]);
}

function pageStats(main, mine) {
  load(
    main,
    mine,
    statsSkeleton(),
    () => api("GET", "/v1/stats"),
    (data) => {
      const releases = data.releases;
      const downloads = releases.ok ? releases.data.downloads.map((day) => day.total) : [];
      const active = releases.ok ? releases.data.active.map((day) => day.total) : [];
      const visits = data.landing.ok ? data.landing.data.days.map((day) => day.visits) : [];
      const art = h(
        "section",
        { class: "home-art art morning" },
        head(title(t("stats.title"), t("stats.titleAccent"), "."), t("stats.sub", { when: fmtWhen(data.generatedAt) })),
        h(
          "div",
          { class: "kpis" },
          statsKpi(t("stats.kpiDownloads"), "download", releases.ok ? fmtNum(sum(downloads)) : "-", releases.ok ? t("stats.kpiDownloadsSub", { n: fmtNum(sum(downloads.slice(-7))) }) : t("stats.kpiMissing"), downloads),
          statsKpi(t("stats.kpiActive"), "activity", releases.ok ? fmtNum(active.at(-1) ?? 0) : "-", releases.ok ? t("stats.kpiActiveSub", { n: fmtNum(active.at(-2) ?? 0) }) : t("stats.kpiMissing"), active),
          statsKpi(t("stats.kpiAccounts"), "team", fmtNum(data.hub.accounts), t("stats.newWeek", { n: fmtNum(data.hub.newThisWeek.accounts) }), data.hub.accountsByDay.map((day) => day.n)),
          statsKpi(t("stats.kpiVisits"), "globe", data.landing.ok ? fmtNum(sum(visits)) : "-", data.landing.ok ? t("stats.kpiVisitsSub", { n: fmtNum(sum(visits.slice(-7))) }) : t("stats.kpiMissing"), visits),
        ),
      );
      append(main, [art, h("div", { class: "bento" }, downloadsCard(releases), countriesCard(releases), activeCard(releases), versionsCard(releases), hubCard(data.hub), landingCard(data.landing))]);
    },
  );
}

// ---- Plan ------------------------------------------------------------------------------------

function planCard({ name, price, unit, items, note, current, dark, freePill }) {
  return h(
    "article",
    { class: `plan${dark ? " dark" : ""}${current ? " current" : ""}` },
    current ? h("span", { class: "chip ink", style: "position:absolute;top:-12px;left:22px", text: t("plan.current") }) : null,
    h("div", { class: "plan-top" }, h("h3", { text: name }), freePill ? h("span", { class: "free", text: t("plan.free") }) : null),
    h("div", { class: "plan-price" }, price, h("small", { text: unit })),
    h("ul", {}, items.map((item) => h("li", {}, icon("check"), item))),
    h("p", { class: "plan-note", text: note }),
  );
}

const fmtEur = (n) => `${new Intl.NumberFormat(locale(), { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n)} €`;
const BILLING_FIELDS = ["legalName", "taxId", "registryNo", "billingEmail", "address", "city", "county", "country"];
const LIVE = ["trialing", "active", "past_due", "unpaid", "incomplete", "paused"];

/** Downloads a file the hub serves only with the session cookie (fetch with x-zen-web, then a blob). */
async function downloadFile(path, fallbackName) {
  const response = await fetch(path, { headers: { "x-zen-web": "1" }, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new ApiError(response.status, typeof json.error === "string" ? json.error : t("err.generic"), json.code ?? null);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens a Stripe page (Checkout or the portal) that the hub asked for. */
async function goStripe(button, errorEl, path, body) {
  await act(button, errorEl, async () => {
    const result = await api("POST", companyPath(path), body);
    location.assign(result.url);
  });
}

function trialLine(b) {
  if (b.status !== "trialing" || !b.trialEnd) return null;
  const days = Math.max(0, Math.ceil((Date.parse(b.trialEnd) - Date.now()) / 86_400_000));
  return days <= 1 ? t("plan.trialLeft1", { date: fmtDate(b.trialEnd) }) : t("plan.trialLeft", { n: days, date: fmtDate(b.trialEnd) });
}

function subscriptionCard(b, manager) {
  const live = LIVE.includes(b.status);
  const error = h("p", { class: "error", role: "alert" });
  const statusChip = h("span", { class: `chip${b.access === "readonly" ? " loud" : b.status === "active" ? " ink" : b.status === "trialing" || b.status === "none" ? " line" : " loud"}`, text: b.status === "none" ? t("plan.status.none") : t(`plan.status.${b.status}`) });
  const trial = trialLine(b);
  const actions = [];
  let serversInput = null;
  if (manager && b.enabled && !live) {
    const upgrade = h("button", { class: "btn loud", type: "button", text: b.trialAvailable && b.trialDays > 0 ? t("plan.upgradeTrial", { n: b.trialDays }) : t("plan.upgrade") });
    if (b.missing.length > 0) upgrade.disabled = true;
    serversInput = b.prices.serverAvailable ? h("input", { type: "number", min: "0", max: "20", value: "0", inputmode: "numeric", style: "width:84px", "aria-label": t("plan.addonAtCheckout") }) : null;
    upgrade.addEventListener("click", () => goStripe(upgrade, error, "/billing/checkout", { servers: serversInput ? Number(serversInput.value || 0) : 0 }));
    actions.push(upgrade);
  }
  if (manager && b.enabled && b.hasCustomer) {
    const portal = h("button", { class: `btn${live ? " primary" : ""}`, type: "button" }, icon("key"), t("plan.manage"));
    portal.addEventListener("click", () => goStripe(portal, error, "/billing/portal"));
    actions.push(portal);
  }
  if (manager && (b.invoices ?? []).length > 0) actions.push(h("a", { class: "btn", href: "#facturi" }, icon("download"), t("plan.downloadInvoices")));
  return h(
    "section",
    { class: "card w2" },
    cardHead(t("plan.sub"), "plan", statusChip),
    h(
      "div",
      { class: "seats" },
      h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(b.seats) }), h("div", { class: "l", text: t("plan.seatsN") })),
      h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(b.guests) }), h("div", { class: "l", text: t("plan.guests") })),
      h("div", { class: "stat" }, h("div", { class: "n", text: fmtNum(b.servers) }), h("div", { class: "l", text: t("plan.servers") })),
      h("div", { class: "stat" }, h("div", { class: "n", text: fmtEur(b.estimate.totalEur) }), h("div", { class: "l", text: t("plan.nextInvoice") })),
    ),
    h("p", { class: "muted small", style: "margin:14px 0 0", text: `${t("plan.subLead")} ${t(`plan.vat.${b.vat.kind}`, { rate: b.vat.rate })}` }),
    trial ? h("p", { class: "note" }, icon("clock"), h("span", { text: trial })) : null,
    live && b.renewsAt && b.status !== "trialing" ? h("p", { class: "note" }, icon("clock"), h("span", { text: b.cancelAtPeriodEnd ? t("plan.endsAt", { date: fmtDate(b.renewsAt) }) : t("plan.renews", { date: fmtDate(b.renewsAt) }) })) : null,
    !live && manager && b.enabled ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("plan.upgradeLead", { n: b.payingMembers, price: b.prices.seatEur }) })) : null,
    !b.enabled ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("plan.notEnabled") })) : null,
    manager && b.enabled && !live && b.missing.length > 0 ? h("p", { class: "note" }, icon("alert"), h("span", {}, t("plan.missing"), " ", h("a", { href: "#facturare", text: t("plan.billingT") }))) : null,
    !manager ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("plan.membersOnly") })) : null,
    actions.length || serversInput ? h("div", { class: "row", style: "margin-top:18px;flex-wrap:wrap;align-items:center" }, actions, serversInput ? h("label", { class: "inline small muted" }, t("plan.addonAtCheckout"), serversInput) : null) : null,
    error,
    b.mode === "test" && b.enabled ? h("p", { class: "muted small", style: "margin:10px 0 0", text: t("plan.testMode") }) : null,
  );
}

function addonCard(b, manager) {
  const live = ["trialing", "active"].includes(b.status);
  const error = h("p", { class: "error", role: "alert" });
  const saved = h("p", { class: "ok-line", role: "status" });
  let control = null;
  if (manager && b.enabled && live && b.prices.serverAvailable) {
    const input = h("input", { type: "number", min: "0", max: "20", value: String(b.servers), inputmode: "numeric", style: "width:84px", "aria-label": t("plan.servers") });
    const save = h("button", { class: "btn primary small", type: "button", text: t("plan.addonSave") });
    save.addEventListener("click", () =>
      act(save, error, async () => {
        await api("PUT", companyPath("/billing/servers"), { servers: Number(input.value || 0) });
        saved.replaceChildren(icon("check"), t("common.saved"));
        state.overview = null;
        route();
      }),
    );
    control = h("div", { class: "row", style: "align-items:center" }, input, save);
  }
  return h(
    "section",
    { class: "card" },
    cardHead(t("plan.addonT"), "server", h("span", { class: "chip line", text: t("plan.addonPrice", { price: b.prices.serverEur }) })),
    h("p", { class: "lede", text: t("plan.addonLead") }),
    control ?? h("p", { class: "note" }, icon("lock"), h("span", { text: live ? t("plan.membersOnly") : t("plan.addonAfter") })),
    error,
    saved,
  );
}

function packagesSection(b, manager) {
  const error = h("p", { class: "error", role: "alert" });
  const paid = new Set((b.orders ?? []).filter((order) => order.status === "paid").map((order) => order.package));
  return h(
    "section",
    { class: "pkgs", id: "pachete" },
    h("div", { class: "card-head", style: "margin:calc(var(--gap) + 12px) 0 6px" }, h("h2", {}, icon("staff"), t("plan.packagesT"))),
    h("p", { class: "lede", style: "margin:0 0 16px", text: t("plan.packagesLead") }),
    h(
      "div",
      { class: "plans" },
      b.packages.map((item, index) => {
        const buy = manager && item.available ? h("button", { class: `btn${index === 1 ? " loud" : " primary"}`, type: "button", text: t("plan.buy", { name: item.name }) }) : null;
        buy?.addEventListener("click", () => goStripe(buy, error, "/billing/packages", { package: item.id }));
        return h(
          "article",
          { class: `plan${index === 1 ? " dark" : ""}` },
          paid.has(item.id) ? h("span", { class: "chip ink", style: "position:absolute;top:-12px;left:22px", text: t("plan.packagePaid") }) : null,
          h("div", { class: "plan-top" }, h("h3", { text: item.name })),
          h("div", { class: "plan-price" }, `${item.priceEur} €`, h("small", { text: t("plan.packageUnit") })),
          h("ul", {}, item.items.map((line) => h("li", {}, icon("check"), line))),
          buy ? h("div", { class: "row", style: "margin-top:auto" }, buy) : null,
        );
      }),
    ),
    error,
  );
}

function fiscalCell(invoice) {
  const fiscal = invoice.fiscal;
  if (fiscal.status === "issued") return h("span", { class: "mono", text: `${fiscal.series && !String(fiscal.number ?? "").startsWith(fiscal.series) ? fiscal.series : ""}${fiscal.number ?? ""}` });
  const key = fiscal.status === "dry_run" ? "plan.fiscalDryRun" : fiscal.status === "failed" ? "plan.fiscalFailed" : "plan.fiscalPending";
  return h("span", { class: "chip line", text: t(key) });
}

function invoicesCard(b) {
  const invoices = b.invoices ?? [];
  const error = h("p", { class: "error", role: "alert" });
  const body =
    invoices.length === 0
      ? emptyState("file", t("plan.invoicesNoneT"), t("plan.invoicesNone"), h("a", { class: "btn small", href: "#facturare" }, t("plan.checkDetails"), icon("arrow")))
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, [t("plan.colDate"), t("plan.colPeriod"), t("plan.colAmount"), t("plan.colFiscal"), t("plan.colEfactura"), ""].map((label) => h("th", { text: label })))),
            h(
              "tbody",
              {},
              invoices.map((invoice) => {
                const pdf = invoice.fiscal.pdf ? h("button", { class: "btn small", type: "button" }, icon("download"), t("plan.pdf")) : null;
                pdf?.addEventListener("click", () => act(pdf, error, () => downloadFile(companyPath(`/billing/invoices/${encodeURIComponent(invoice.id)}/pdf`), `factura-${invoice.id}.pdf`)));
                return h(
                  "tr",
                  {},
                  h("td", { text: fmtDate(invoice.paidAt) }),
                  h("td", { class: "muted", text: invoice.kind === "package" ? t("plan.packageKind") : invoice.periodStart && invoice.periodEnd ? `${fmtDate(invoice.periodStart)} – ${fmtDate(invoice.periodEnd)}` : t("plan.subscriptionKind") }),
                  h("td", { class: "num", style: "white-space:nowrap", text: fmtEur(invoice.amountEur) }),
                  h("td", {}, fiscalCell(invoice)),
                  h("td", {}, invoice.fiscal.efactura ? h("span", { class: `chip${invoice.fiscal.efactura === "accepted" ? " ink" : invoice.fiscal.efactura === "rejected" ? " loud" : " line"}`, text: t(`plan.ef.${invoice.fiscal.efactura}`) }) : h("span", { class: "muted", text: "—" })),
                  h("td", { class: "actions" }, pdf, invoice.stripePdfUrl ? h("a", { class: "btn small", href: invoice.stripePdfUrl, target: "_blank", rel: "noopener noreferrer" }, t("plan.receipt")) : null),
                );
              }),
            ),
          ),
        );
  return h("section", { class: "card w2", id: "facturi" }, cardHead(t("plan.invoices"), "file"), h("p", { class: "muted small", style: "margin:0 0 12px", text: t("plan.invoicesLead") }), body, error);
}

function billingDetailsCard(b, onSaved) {
  const details = b.details ?? {};
  const inputs = Object.fromEntries(
    BILLING_FIELDS.map((field) => [
      field,
      h("input", {
        value: details[field] ?? (field === "country" ? "RO" : ""),
        name: field,
        type: field === "billingEmail" ? "email" : "text",
        class: field === "taxId" || field === "registryNo" || field === "country" ? "mono" : null,
        maxlength: field === "country" ? "60" : null,
        autocomplete: field === "billingEmail" ? "email" : field === "legalName" ? "organization" : null,
        "aria-invalid": b.missing.includes(field) ? "true" : null,
      }),
    ]),
  );
  const save = h("button", { class: "btn primary", type: "submit", text: t("common.save") });
  const error = h("p", { class: "error", role: "alert" });
  const saved = h("p", { class: "ok-line", role: "status" });
  const vies = b.vatCheck && b.vatCheck !== "not_eu" ? h("p", { class: "note" }, icon(b.vatCheck === "valid" ? "check" : "alert"), h("span", { text: t(`plan.vies.${b.vatCheck}`) })) : null;
  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("div", { class: "form-grid" }, BILLING_FIELDS.map((field) => h("label", { class: field === "address" || field === "legalName" ? "wide" : null }, field === "country" ? t("plan.country") : t(`company.${field}`), inputs[field]))),
    h("div", { class: "row" }, save),
    error,
    saved,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = "";
    act(save, error, async () => {
      const result = await api("PUT", companyPath("/billing/details"), { details: Object.fromEntries(BILLING_FIELDS.map((field) => [field, inputs[field].value.trim()])) });
      state.overview = null;
      onSaved(result.billing);
    });
  });
  return h("section", { class: "card", id: "facturare" }, cardHead(t("plan.billingT"), "company"), h("p", { class: "muted small", style: "margin:0 0 12px", text: t("plan.billingLead") }), form, vies, h("p", { class: "note" }, icon("file"), h("span", { text: t(`plan.vat.${b.vat.kind}`, { rate: b.vat.rate }) })));
}

function pagePlan(main, mine) {
  if (state.companyId === null) return noCompany(main);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "bento" }, cardSkeleton(3, { cls: "w2", number: true }), cardSkeleton(2)), h("div", { class: "plans", style: "margin-top:22px" }, bones(3, "b-card card"))],
    () => api("GET", companyPath("/billing")),
    (data) => drawPlan(main, data.role, data.billing),
  );
}

function drawPlan(main, role, b) {
  const manager = isManager(role);
  const hosted = b.hosted;
  const company = currentCompany();
  const planInfo = { kind: hosted ? "hosted" : "selfhost", status: b.status, access: b.access, reason: b.reason, graceEndsAt: b.graceEndsAt };
  const query = new URLSearchParams(location.search);
  const paid = query.get("plata");
  const notice =
    paid === "ok" ? t("plan.paidOk") : paid === "pachet" ? t("plan.paidPackage") : paid === "anulat" ? t("plan.paidCancel") : null;
  if (paid !== null) history.replaceState(null, "", "/app/plan");
  if (paid === "ok" && !LIVE.includes(b.status)) {
    // The webhook usually lands within seconds of the redirect back.
    setTimeout(() => {
      if (pageName() === "plan") route();
    }, 4000);
  }
  const redraw = (next) => {
    main.replaceChildren();
    drawPlan(main, role, next);
  };
  append(main, [
    head(title(t("plan.title"), t("plan.titleAccent")), [h("span", { text: company?.name ?? "" }), h("span", { class: "dot-sep", text: planLine(planInfo) })]),
    billingBanner(planInfo, b.graceEndsAt),
    notice ? h("div", { class: "banner ok", role: "status" }, icon("check"), h("span", { class: "grow", text: notice })) : null,
    hosted
      ? h("div", { class: "bento" }, subscriptionCard(b, manager), addonCard(b, manager))
      : h("section", { class: "card" }, cardHead(t("plan.seatsCost"), "plan", h("span", { class: "chip line", text: t("plan.free") })), h("p", { class: "note" }, icon("lock"), h("span", { text: t("plan.selfhostLead") }))),
    h(
      "div",
      { class: "plans", style: "margin-top:calc(var(--gap) + 8px)" },
      planCard({ name: t("plan.personal"), price: "0 €", unit: t("plan.personalFor"), items: [t("plan.personal1"), t("plan.personal2"), t("plan.personal3")], note: t("plan.personalNote"), freePill: true }),
      planCard({ name: t("plan.selfhost"), price: "0 €", unit: t("plan.selfhostFor"), items: [t("plan.selfhost1"), t("plan.selfhost2"), t("plan.selfhost3")], note: t("plan.selfhostNote"), freePill: true, current: !hosted }),
      planCard({ name: t("plan.hostedName"), price: `${b.prices.seatEur} €`, unit: t("plan.hostedFor"), items: [t("plan.hosted1"), t("plan.hosted2"), t("plan.hosted3")], note: t("plan.hostedNote"), dark: true, current: hosted }),
    ),
    hosted ? packagesSection(b, manager) : null,
    hosted && manager ? h("div", { class: "bento", style: "margin-top:calc(var(--gap) + 8px)" }, invoicesCard(b), billingDetailsCard(b, redraw)) : null,
  ]);
  if (location.hash) main.querySelector(location.hash)?.scrollIntoView();
}

// ---- Invitație -------------------------------------------------------------------------------

function invitesForMeCard() {
  const invites = state.me.invites ?? [];
  return h(
    "section",
    { class: "card" },
    cardHead(t("invite.mine", { email: state.me.user.email }), "mail"),
    invites.length === 0
      ? h("p", { class: "muted", text: t("invite.mineNone") })
      : h(
          "div",
          { class: "aps" },
          invites.map((invite) => {
            const error = h("span", { class: "error small" });
            const accept = h("button", { class: "btn primary small", type: "button", text: t("invite.accept") });
            accept.addEventListener("click", () =>
              act(accept, error, async () => {
                const result = await api("POST", "/v1/invites/accept", { inviteId: invite.id });
                setCompany(result.companyId);
                await loadMe();
                go("acasa");
              }),
            );
            return approvalItem({ who: invite.companyName, kind: t("home.apInvite"), heading: t("home.apInviteTitle", { company: invite.companyName, role: t(`role.${invite.role}`).toLowerCase() }), actions: [accept, error] });
          }),
        ),
    h("p", { class: "small", style: "margin:14px 0 0" }, h("a", { href: "/app/invitatie", text: t("invite.paste") })),
  );
}

function pageInvite(main) {
  const token = location.hash.length > 1 ? location.hash.slice(1) : "";
  const field = h("input", { class: "mono", value: token === "" ? "" : `${location.origin}/invite#${token}`, placeholder: `${location.origin}/invite#...`, "aria-label": t("invite.paste") });
  const accept = h("button", { class: "btn loud", type: "submit", text: t("invite.accept") });
  const error = h("p", { class: "error", role: "alert" });
  const done = h("p", { class: "ok-line", role: "status" });
  const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("invite.paste"), field), h("div", { class: "row" }, accept), error, done);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    act(accept, error, async () => {
      const value = field.value.trim();
      const result = await api("POST", "/v1/invites/accept", { token: value.includes("#") ? value.split("#").pop() : value });
      history.replaceState(null, "", "/app/invitatie");
      setCompany(result.companyId);
      await loadMe();
      done.replaceChildren(icon("check"), t("invite.accepted", { company: currentCompany()?.name ?? "" }));
      if (state.me.twoFactor.gate !== "ok") return go("intra", { replace: true });
      setTimeout(() => go("acasa"), 900);
    });
  });
  main.replaceChildren(
    h("section", { class: "home-art art morning" }, head(title(t("invite.title"), t("invite.titleAccent"), "."), t("invite.lead")), h("div", { class: "kpi", style: "max-width:640px" }, form)),
    h("div", { class: "cols" }, invitesForMeCard()),
  );
}

// ---- Bibliotecă (the community library): my packs and their review status ---------------------

Object.assign(DICT.ro, {
  "lib.title": "Biblioteca",
  "lib.titleAccent": "comunității",
  "lib.lead": "Pachete gratuite făcute de oameni care folosesc Zen Staff, verificate de noi înainte să apară la toți. Publici din aplicație: la un pachet personalizat sau al tău, „Publică în bibliotecă”.",
  "lib.status.pending": "În verificare",
  "lib.status.changes_requested": "Cere modificări",
  "lib.status.published": "Publicat",
  "lib.status.rejected": "Respins",
  "lib.status.superseded": "Versiune veche",
  "lib.status.withdrawn": "Înlocuit de o trimitere nouă",
  "lib.level.pass": "Trecut",
  "lib.level.warn": "De verificat",
  "lib.level.fail": "Picat",
  "lib.check.schema": "Structura pachetului",
  "lib.check.forbidden-keys": "Chei interzise",
  "lib.check.secrets": "Secrete",
  "lib.check.dependencies": "Unelte și avertismente",
  "lib.check.size": "Mărime",
  "lib.check.scripts": "Scripturi",
  "lib.reason.unsafe": "nesigur",
  "lib.reason.broken": "nu merge",
  "lib.reason.secrets": "cere sau conține chei",
  "lib.reason.spam": "spam",
  "lib.reason.copyright": "drepturi de autor",
  "lib.reason.other": "altceva",
  "lib.install1": "1 instalare",
  "lib.installs": "{n} instalări",
  "lib.findings": "{n} observații",
  "lib.displayName": "Numele afișat",
  "lib.displayNameLabel": "Numele afișat la pachete",
  "lib.company": "Firma",
  "lib.companyLabel": "Firma (opțional)",
  "lib.verified": "Verificat de Zen",
  "lib.featured": "Recomandat",
  "lib.unpublished": "Scos din bibliotecă: {reason}",
  "lib.submitted": "trimis {when}",
  "lib.decided": "decis {when}",
  "lib.sharePage": "Pagina de partajare",
  "lib.mine": "Pachetele tale",
  "lib.mineNoneT": "Încă nu ai publicat nimic",
  "lib.mineNone": "În Zen Staff, la Bibliotecă sau pe cardul unui flux personalizat, apasă „Publică în bibliotecă”. Aici vezi apoi starea: În verificare, Cere modificări, Publicat sau Respins.",
  "lib.author": "Cum apari ca autor",
  "lib.authorNote": "Totul e gratuit: nu vindem pachete și nu plătim autorii. Primești credit: numele tău pe fiecare pachet, pagina ta de autor și numărul de instalări.",
  "lib.diffNone": "Niciun fișier schimbat.",
  "lib.file.added": "nou",
  "lib.file.removed": "șters",
  "lib.file.changed": "schimbat",
  "lib.diffBinary": "Fișier binar sau prea mare pentru diff.",
  "lib.testLink": "Link de test",
  "lib.testLinkLabel": "Linkul de test",
  "lib.copyLink": "Copiază linkul",
  "lib.note": "Nota pentru autor",
  "lib.notePlaceholder": "Ce trebuie schimbat sau de ce e respins. Autorul o vede în aplicație.",
  "lib.publishedNow": "publicat acum: {version}",
  "lib.newPack": "pachet nou",
  "lib.backToQueue": "Înapoi la coadă",
  "lib.checks": "Verificări automate",
  "lib.diffAgainst": "Diferențe față de {version}",
  "lib.diffNew": "Fișierele pachetului (pachet nou)",
  "lib.screenshots": "Imagini cu rezultatul",
  "lib.decision": "Decizie",
  "lib.description": "Descriere",
  "lib.sampleOutput": "Rezultat",
  "lib.changelog": "Ce e nou",
  "lib.openReportsN": "{n} raportări deschise",
  "lib.approve": "Aprobă și publică",
  "lib.requestChanges": "Cere modificări",
  "lib.reject": "Respinge",
  "lib.testRun": "Rulare de test, izolată",
  "lib.history": "Istoric",
  "lib.queue": "De verificat ({n})",
  "lib.queueEmptyT": "Coada e goală",
  "lib.queueEmpty": "Nicio trimitere nu așteaptă. Pachetele noi și actualizările apar aici după verificările automate.",
  "lib.updateFrom": "actualizare de la {version}",
  "lib.reportsN": "{n} raportări",
  "lib.toCheck": "{n} de verificat",
  "lib.reports": "Raportări deschise ({n})",
  "lib.reportsNone": "Nicio raportare deschisă.",
  "lib.resolution": "Rezolvare",
  "lib.resolutionPlaceholder": "Ce ai făcut",
  "lib.resolve": "Rezolvă",
  "lib.published": "Pachete publicate",
  "lib.feature": "Recomandă",
  "lib.unfeature": "Scoate recomandarea",
  "lib.unpublish": "Scoate din bibliotecă",
  "lib.unpublishReason": "Scos de echipa Zen după verificare.",
  "lib.republish": "Publică din nou",
  "lib.stPublished": "publicat",
  "lib.stRemoved": "scos: {reason}",
  "lib.reviewTitle": "Verificarea",
  "lib.reviewTitleAccent": "bibliotecii",
  "lib.reviewLead": "Doar pentru echipa Zen: fiecare pachet și fiecare actualizare trec pe aici înainte să apară la toți.",
});

Object.assign(DICT.en, {
  "lib.title": "Community",
  "lib.titleAccent": "library",
  "lib.lead": "Free packs made by people who use Zen Staff, reviewed by us before everyone can see them. You publish from the app: on a customised pack or one of your own, \"Publish to the library\".",
  "lib.status.pending": "In review",
  "lib.status.changes_requested": "Changes requested",
  "lib.status.published": "Published",
  "lib.status.rejected": "Rejected",
  "lib.status.superseded": "Old version",
  "lib.status.withdrawn": "Replaced by a newer submission",
  "lib.level.pass": "Passed",
  "lib.level.warn": "To check",
  "lib.level.fail": "Failed",
  "lib.check.schema": "Pack structure",
  "lib.check.forbidden-keys": "Forbidden keys",
  "lib.check.secrets": "Secrets",
  "lib.check.dependencies": "Tools and warnings",
  "lib.check.size": "Size",
  "lib.check.scripts": "Scripts",
  "lib.reason.unsafe": "unsafe",
  "lib.reason.broken": "does not work",
  "lib.reason.secrets": "asks for or contains keys",
  "lib.reason.spam": "spam",
  "lib.reason.copyright": "copyright",
  "lib.reason.other": "something else",
  "lib.install1": "1 install",
  "lib.installs": "{n} installs",
  "lib.findings": "{n} findings",
  "lib.displayName": "Display name",
  "lib.displayNameLabel": "Name shown on your packs",
  "lib.company": "Company",
  "lib.companyLabel": "Company (optional)",
  "lib.verified": "Reviewed by Zen",
  "lib.featured": "Featured",
  "lib.unpublished": "Removed from the library: {reason}",
  "lib.submitted": "submitted {when}",
  "lib.decided": "decided {when}",
  "lib.sharePage": "Share page",
  "lib.mine": "Your packs",
  "lib.mineNoneT": "You have not published anything yet",
  "lib.mineNone": "In Zen Staff, in the Library or on the card of a customised workflow, press \"Publish to the library\". Then you see its status here: In review, Changes requested, Published or Rejected.",
  "lib.author": "How you appear as an author",
  "lib.authorNote": "Everything is free: we do not sell packs and we do not pay authors. You get credit: your name on each pack, your author page and the install count.",
  "lib.diffNone": "No files changed.",
  "lib.file.added": "new",
  "lib.file.removed": "deleted",
  "lib.file.changed": "changed",
  "lib.diffBinary": "Binary file, or too large for a diff.",
  "lib.testLink": "Test link",
  "lib.testLinkLabel": "The test link",
  "lib.copyLink": "Copy the link",
  "lib.note": "Note for the author",
  "lib.notePlaceholder": "What has to change, or why it is rejected. The author sees it in the app.",
  "lib.publishedNow": "published now: {version}",
  "lib.newPack": "new pack",
  "lib.backToQueue": "Back to the queue",
  "lib.checks": "Automatic checks",
  "lib.diffAgainst": "Changes since {version}",
  "lib.diffNew": "The pack's files (new pack)",
  "lib.screenshots": "Screenshots of the result",
  "lib.decision": "Decision",
  "lib.description": "Description",
  "lib.sampleOutput": "Result",
  "lib.changelog": "What's new",
  "lib.openReportsN": "{n} open reports",
  "lib.approve": "Approve and publish",
  "lib.requestChanges": "Request changes",
  "lib.reject": "Reject",
  "lib.testRun": "Test run, isolated",
  "lib.history": "History",
  "lib.queue": "To review ({n})",
  "lib.queueEmptyT": "The queue is empty",
  "lib.queueEmpty": "No submission is waiting. New packs and updates show up here after the automatic checks.",
  "lib.updateFrom": "update from {version}",
  "lib.reportsN": "{n} reports",
  "lib.toCheck": "{n} to check",
  "lib.reports": "Open reports ({n})",
  "lib.reportsNone": "No open reports.",
  "lib.resolution": "Resolution",
  "lib.resolutionPlaceholder": "What you did",
  "lib.resolve": "Resolve",
  "lib.published": "Published packs",
  "lib.feature": "Feature",
  "lib.unfeature": "Remove from featured",
  "lib.unpublish": "Remove from the library",
  "lib.unpublishReason": "Removed by the Zen team after review.",
  "lib.republish": "Publish again",
  "lib.stPublished": "published",
  "lib.stRemoved": "removed: {reason}",
  "lib.reviewTitle": "Library",
  "lib.reviewTitleAccent": "review",
  "lib.reviewLead": "For the Zen team only: every pack and every update passes through here before everyone can see it.",
});

const LIB_STATUS = { pending: "line", changes_requested: "loud", published: "ink", rejected: "loud", superseded: "line", withdrawn: "line" };
const libStatusChip = (status) => h("span", { class: `chip ${LIB_STATUS[status] ?? "line"}`, text: LIB_STATUS[status] ? t(`lib.status.${status}`) : status });
const LIB_LEVEL = { pass: "ink", warn: "line", fail: "loud" };
const LIB_CHECKS = ["schema", "forbidden-keys", "secrets", "dependencies", "size", "scripts"];
const REPORT_REASONS = ["unsafe", "broken", "secrets", "spam", "copyright", "other"];
const installsWord = (n) => (n === 1 ? t("lib.install1") : t("lib.installs", { n: fmtNum(n) }));

function checksList(checks, full = false) {
  return h(
    "ul",
    { class: "list lib-checks" },
    checks.map((check) =>
      h(
        "li",
        {},
        h("span", { class: `dot${check.level === "pass" ? " on" : check.level === "fail" ? " bad" : ""}` }),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "title", text: LIB_CHECKS.includes(check.id) ? t(`lib.check.${check.id}`) : check.id }),
          full && check.findings?.length ? h("ul", { class: "findings" }, check.findings.map((line) => h("li", { text: line }))) : h("div", { class: "meta", text: t("lib.findings", { n: check.findings ? check.findings.length : check.count }) }),
        ),
        h("span", { class: `chip ${LIB_LEVEL[check.level]}`, text: t(`lib.level.${check.level}`) }),
      ),
    ),
  );
}

function pageLibrary(main, mine) {
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols" }, cardSkeleton(4), cardSkeleton(3))],
    () => api("GET", "/v1/library/me"),
    (data) => {
      state.library = data;
      const name = h("input", { value: data.author?.name ?? state.me.user.name ?? "", "aria-label": t("lib.displayName"), maxlength: "80" });
      const company = h("input", { value: data.author?.company ?? "", "aria-label": t("lib.company"), maxlength: "80", placeholder: t("ph.authorCompany") });
      const save = h("button", { class: "btn primary", type: "submit", text: t("common.save") });
      const error = h("p", { class: "error", role: "alert" });
      const done = h("p", { class: "ok-line", role: "status" });
      const form = h("form", { class: "form", novalidate: true }, h("label", {}, t("lib.displayNameLabel"), name), h("label", {}, t("lib.companyLabel"), company), h("div", { class: "row" }, save), error, done);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        act(save, error, async () => {
          await api("PUT", "/v1/library/me/author", { displayName: name.value.trim(), company: company.value.trim() });
          done.replaceChildren(icon("check"), t("common.saved"));
        });
      });
      const packs = data.packs.map((pack) => {
        const latest = pack.versions[0];
        return h(
          "article",
          { class: "card mcard" },
          h("div", { class: "mcard-top" }, h("span", { class: "os" }, icon("packs")), h("div", { class: "grow" }, h("b", { text: latest?.title ?? pack.packId }), h("span", { class: "mono", text: pack.packId })), pack.state === "published" ? stamp(t("lib.verified"), { ink: false }) : null),
          h("p", { class: "meta" }, `${installsWord(pack.installs)}${pack.featured ? ` · ${t("lib.featured")}` : ""}`),
          pack.state === "unpublished" ? h("p", { class: "error", text: t("lib.unpublished", { reason: pack.unpublishedReason ?? "" }) }) : null,
          h(
            "ul",
            { class: "list" },
            pack.versions.slice(0, 4).map((version) =>
              h(
                "li",
                {},
                h("div", { class: "grow" }, h("div", { class: "title" }, h("span", { class: "mono", text: version.version }), " ", libStatusChip(version.status)), h("div", { class: "meta", text: `${t("lib.submitted", { when: fmtWhen(version.submittedAt) })}${version.decidedAt ? ` · ${t("lib.decided", { when: fmtWhen(version.decidedAt) })}` : ""}` }), version.reviewNote ? h("p", { class: "lib-note", text: version.reviewNote }) : null),
              ),
            ),
          ),
          pack.shareUrl ? h("div", { class: "row" }, h("a", { class: "btn small", href: pack.shareUrl, target: "_blank", rel: "noopener" }, icon("link"), t("lib.sharePage"))) : null,
        );
      });
      append(main, [
        head(title(t("lib.title"), t("lib.titleAccent")), t("lib.lead")),
        h(
          "div",
          { class: "cols" },
          h("section", { class: "card" }, cardHead(t("lib.mine"), "packs"), data.packs.length === 0 ? emptyState("packs", t("lib.mineNoneT"), t("lib.mineNone"), downloadLink("btn primary")) : h("div", { class: "tiles" }, packs)),
          h("section", { class: "card" }, cardHead(t("lib.author"), "user"), form, h("p", { class: "note prose" }, icon("key"), h("span", { text: t("lib.authorNote") }))),
        ),
      ]);
    },
  );
}

// ---- Verificare (hub reviewers only): queue, checks, diff, test run, decisions, reports ---------

function diffView(files) {
  if (files.length === 0) return h("p", { class: "meta", text: t("lib.diffNone") });
  return h(
    "div",
    { class: "lib-diff" },
    files.map((file) =>
      h(
        "details",
        { open: files.length <= 4 },
        h("summary", {}, h("span", { class: `chip ${file.change === "removed" ? "loud" : file.change === "added" ? "ink" : "line"}`, text: ["added", "removed", "changed"].includes(file.change) ? t(`lib.file.${file.change}`) : file.change }), " ", h("span", { class: "mono", text: file.path })),
        file.lines === null ? h("p", { class: "meta", text: t("lib.diffBinary") }) : h("pre", { class: "mono" }, file.lines.map((line) => h("span", { class: line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "", text: `${line}\n` }))),
      ),
    ),
  );
}

function reviewDetail(main, mine, id) {
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols" }, cardSkeleton(6), cardSkeleton(4))],
    () => api("GET", `/v1/library/review/versions/${encodeURIComponent(id)}`),
    (data) => {
      const steps = h("ol", { class: "lib-steps" }, data.testRun.map((step) => h("li", { text: step })));
      const linkButton = h("button", { class: "btn small", type: "button" }, icon("link"), t("lib.testLink"));
      const linkError = h("p", { class: "error", role: "alert" });
      const linkBox = h("div", { class: "row lib-link" });
      linkButton.addEventListener("click", () =>
        act(linkButton, linkError, async () => {
          const preview = await api("POST", `/v1/library/review/versions/${encodeURIComponent(id)}/preview`);
          steps.replaceChildren(...preview.steps.map((step) => h("li", { text: step })));
          const copy = h("button", { class: "btn small", type: "button" }, icon("copy"), t("lib.copyLink"));
          copy.addEventListener("click", async () => {
            await navigator.clipboard.writeText(preview.url).catch(() => undefined);
            copy.replaceChildren(icon("check"), t("common.copied"));
          });
          linkBox.replaceChildren(h("input", { class: "mono", readonly: true, value: preview.url, "aria-label": t("lib.testLinkLabel") }), copy);
        }),
      );
      const note = h("textarea", { rows: "4", "aria-label": t("lib.note"), placeholder: t("lib.notePlaceholder") });
      const error = h("p", { class: "error", role: "alert" });
      const decide = (decision, label, cls) => {
        const button = h("button", { class: `btn ${cls}`, type: "button", text: label });
        button.addEventListener("click", () =>
          act(button, error, async () => {
            await api("POST", `/v1/library/review/versions/${encodeURIComponent(id)}/decision`, { decision, note: note.value.trim() });
            go("admin/biblioteca");
          }),
        );
        return button;
      };
      const pending = data.status === "pending";
      append(main, [
        head(title(data.title, data.version), `${data.author?.name ?? ""} · ${data.packId} · ${t("lib.submitted", { when: fmtWhen(data.submittedAt) })} · ${data.previousVersion ? t("lib.publishedNow", { version: data.previousVersion }) : t("lib.newPack")}`, h("a", { class: "btn", href: "/app/admin/biblioteca" }, t("lib.backToQueue"))),
        h(
          "div",
          { class: "cols side-right" },
          h(
            "div",
            { class: "stack" },
            h("section", { class: "card" }, cardHead(t("lib.checks"), "security"), checksList(data.checks, true)),
            h("section", { class: "card" }, cardHead(data.diffAgainst ? t("lib.diffAgainst", { version: data.diffAgainst }) : t("lib.diffNew"), "file"), diffView(data.diff)),
            data.screenshots.length ? h("section", { class: "card" }, cardHead(t("lib.screenshots"), "monitor"), h("div", { class: "lib-shots" }, data.screenshots.map((shot) => h("img", { src: shot.src, alt: shot.name })))) : null,
          ),
          h(
            "div",
            { class: "stack" },
            h(
              "section",
              { class: "card" },
              cardHead(t("lib.decision"), "checkCircle"),
              h("p", {}, h("b", { text: `${t("lib.description")}: ` }), data.meta.description),
              data.meta.sampleOutput ? h("p", {}, h("b", { text: `${t("lib.sampleOutput")}: ` }), data.meta.sampleOutput) : null,
              data.meta.changelog ? h("p", {}, h("b", { text: `${t("lib.changelog")}: ` }), data.meta.changelog) : null,
              h("p", { class: "meta", text: `${data.meta.category} · ${data.meta.licence} · ${data.meta.language} · ${fmtNum(data.size)} B · ${t("lib.openReportsN", { n: data.openReports })}` }),
              pending ? h("label", {}, t("lib.note"), note) : h("p", {}, libStatusChip(data.status), data.reviewNote ? ` ${data.reviewNote}` : ""),
              pending ? h("div", { class: "row" }, decide("approve", t("lib.approve"), "primary"), decide("changes", t("lib.requestChanges"), ""), decide("reject", t("lib.reject"), "danger")) : null,
              error,
            ),
            h("section", { class: "card" }, cardHead(t("lib.testRun"), "terminal"), steps, linkBox, h("div", { class: "row" }, linkButton), linkError),
            data.reviews.length ? h("section", { class: "card" }, cardHead(t("lib.history"), "clock"), h("ul", { class: "list" }, data.reviews.map((review) => h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: `${review.reviewerName ?? ""}: ${review.decision}` }), h("div", { class: "meta", text: `${fmtWhen(review.createdAt)} ${review.note}` })))))) : null,
          ),
        ),
      ]);
    },
  );
}

function pageReview(main, mine, opts = {}) {
  // A submission opens as /app/admin/biblioteca#<id> (the hub serves its known paths only).
  const id = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  if (id !== "") return reviewDetail(main, mine, id);
  load(
    main,
    mine,
    [headSkeleton(), h("div", { class: "cols" }, cardSkeleton(5), cardSkeleton(4))],
    async () => {
      const [queue, reports, packs, auditLog] = await Promise.all([api("GET", "/v1/library/review/queue"), api("GET", "/v1/library/review/reports?status=open"), api("GET", "/v1/library/review/packs"), api("GET", "/v1/library/review/audit")]);
      return { queue, reports: reports.reports, packs: packs.packs, audit: auditLog.entries };
    },
    (data) => {
      const queueCard = h(
        "section",
        { class: "card" },
        cardHead(t("lib.queue", { n: data.queue.items.length }), "inbox"),
        data.queue.items.length === 0
          ? emptyState("checkCircle", t("lib.queueEmptyT"), t("lib.queueEmpty"))
          : h(
              "ul",
              { class: "list" },
              data.queue.items.map((item) =>
                h(
                  "li",
                  {},
                  h("span", { class: `dot${item.checks.some((check) => check.level === "warn") ? "" : " on"}` }),
                  h("div", { class: "grow" }, h("a", { class: "title", href: `/app/admin/biblioteca#${encodeURIComponent(item.id)}`, text: `${item.title} ${item.version}` }), h("div", { class: "meta", text: `${item.author?.name ?? ""} · ${item.previousVersion ? t("lib.updateFrom", { version: item.previousVersion }) : t("lib.newPack")} · ${fmtWhen(item.submittedAt)}${item.openReports ? ` · ${t("lib.reportsN", { n: item.openReports })}` : ""}` })),
                  h("span", { class: "chip line", text: t("lib.toCheck", { n: item.checks.filter((check) => check.level === "warn").length }) }),
                ),
              ),
            ),
      );
      const reportsCard = h(
        "section",
        { class: "card" },
        cardHead(t("lib.reports", { n: data.reports.length }), "alert"),
        data.reports.length === 0
          ? h("p", { class: "meta", text: t("lib.reportsNone") })
          : h(
              "ul",
              { class: "list" },
              data.reports.map((report) => {
                const resolution = h("input", { "aria-label": t("lib.resolution"), placeholder: t("lib.resolutionPlaceholder") });
                const error = h("p", { class: "error", role: "alert" });
                const button = h("button", { class: "btn small", type: "button", text: t("lib.resolve") });
                button.addEventListener("click", () => act(button, error, async () => {
                  await api("POST", `/v1/library/review/reports/${encodeURIComponent(report.id)}/resolve`, { resolution: resolution.value.trim() });
                  route();
                }));
                return h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: `${report.packId}: ${REPORT_REASONS.includes(report.reason) ? t(`lib.reason.${report.reason}`) : report.reason}` }), h("div", { class: "meta", text: `${fmtWhen(report.createdAt)} ${report.detail}` }), h("div", { class: "row" }, resolution, button), error));
              }),
            ),
      );
      const packsCard = h(
        "section",
        { class: "card" },
        cardHead(t("lib.published"), "packs"),
        h(
          "ul",
          { class: "list" },
          data.packs.map((pack) => {
            const error = h("p", { class: "error", role: "alert" });
            const feature = h("button", { class: "btn small", type: "button", text: pack.featured ? t("lib.unfeature") : t("lib.feature") });
            feature.addEventListener("click", () => act(feature, error, async () => {
              await api("POST", `/v1/library/review/packs/${encodeURIComponent(pack.slug)}/featured`, { featured: !pack.featured });
              route();
            }));
            const toggle =
              pack.state === "published"
                ? confirmButton(t("lib.unpublish"), (button) => act(button, error, async () => {
                    await api("POST", `/v1/library/review/packs/${encodeURIComponent(pack.slug)}/unpublish`, { reason: t("lib.unpublishReason") });
                    route();
                  }))
                : h("button", { class: "btn small", type: "button", text: t("lib.republish"), onclick: (event) => act(event.currentTarget, error, async () => {
                    await api("POST", `/v1/library/review/packs/${encodeURIComponent(pack.slug)}/republish`);
                    route();
                  }) });
            return h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: `${pack.title} ${pack.version ?? ""}` }), h("div", { class: "meta", text: `${pack.author?.name ?? ""} · ${installsWord(pack.installs)} · ${pack.state === "published" ? t("lib.stPublished") : t("lib.stRemoved", { reason: pack.unpublishedReason ?? "" })}${pack.featured ? ` · ${t("lib.featured").toLowerCase()}` : ""}` }), h("div", { class: "row" }, feature, toggle), error));
          }),
        ),
      );
      const auditCard = h(
        "section",
        { class: "card" },
        cardHead(t("nav.journal"), "activity"),
        h("ul", { class: "list" }, data.audit.slice(0, 30).map((entry) => h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: entry.detail }), h("div", { class: "meta", text: `${entry.actorName ?? ""} · ${entry.action.replace(/^library\./, "")} · ${fmtWhen(entry.createdAt)}` }))))),
      );
      append(main, [opts.embedded ? null : head(title(t("lib.reviewTitle"), t("lib.reviewTitleAccent")), t("lib.reviewLead")), h("div", { class: "cols" }, queueCard, reportsCard, packsCard, auditCard), opts.after ?? null]);
    },
  );
}

// ---- Administrare: the platform admin (hub staff only) -----------------------------------------
// One page, /app/admin/<tab>. The hub checks the staff role, the two-factor session and the tab's
// permission on every request and writes each one to the platform journal; the page only hides
// what a role cannot open. Only metadata is shown: no chats, shared views, memory, files or
// approval contents, and no "sign in as".

Object.assign(DICT.ro, {
  "admin.title": "Administrarea",
  "admin.titleAccent": "platformei",
  "admin.privacy": "Doar metadate. Echipa Zen nu poate citi chaturile, vizualizările partajate, memoria, fișierele sau conținutul aprobărilor unei firme și nu poate intra în contul nimănui. Fiecare pagină deschisă aici și fiecare acțiune intră în jurnalul platformei.",
  "admin.tabs": "Secțiunile administrării",
  "admin.tab.cifre": "Cifre",
  "admin.tab.firme": "Firme",
  "admin.tab.conturi": "Conturi",
  "admin.tab.abonamente": "Abonamente",
  "admin.tab.suport": "Suport",
  "admin.tab.biblioteca": "Bibliotecă",
  "admin.tab.jurnal": "Jurnal admin",
  "admin.role.operator": "Operator",
  "admin.role.reviewer": "Verificator",
  "admin.role.support": "Suport",
  "admin.mfaT": "Administrarea cere o sesiune cu doi pași",
  "admin.mfa": "Ai intrat fără codul din aplicația de autentificare. Pornește autentificarea în doi pași la Securitate (dacă nu e pornită), ieși din cont și intră din nou cu codul.",
  "admin.search": "Caută",
  "admin.searchCompany": "Nume, e-mailul ownerului sau id",
  "admin.searchAccount": "E-mail, nume sau id",
  "admin.any": "Toate",
  "admin.plan": "Plan",
  "admin.status": "Stare",
  "admin.suspended": "Suspendare",
  "admin.suspendedYes": "Suspendate",
  "admin.suspendedNo": "Active",
  "admin.sort": "Ordine",
  "admin.sortNew": "Cele mai noi",
  "admin.sortName": "Nume",
  "admin.sortActivity": "Ultima activitate",
  "admin.company": "Firma",
  "admin.owner": "Owner",
  "admin.seats": "Locuri folosite / plătite",
  "admin.members": "Membri",
  "admin.created": "Creată",
  "admin.lastActivity": "Ultima activitate",
  "admin.runner": "Runner",
  "admin.packs": "Pachete publicate",
  "admin.none": "Nimic nu se potrivește filtrelor.",
  "admin.total": "{n} în total",
  "admin.prev": "Înapoi",
  "admin.next": "Înainte",
  "admin.pages": "Pagini",
  "admin.page": "Pagina {n}",
  "admin.details": "Detalii",
  "admin.account": "Cont",
  "admin.companies": "Firme",
  "admin.twofa": "Doi pași",
  "admin.lastSignIn": "Ultima intrare",
  "admin.devices": "Dispozitive",
  "admin.sessions": "Sesiuni",
  "admin.on": "pornit",
  "admin.off": "oprit",
  "admin.isSuspended": "Suspendat",
  "admin.reason": "Motivul (intră în jurnal)",
  "admin.reasonShort": "Scrie motivul, minim 5 caractere.",
  "admin.done": "Gata.",
  "plan.founder": "Fondator",
  "admin.planFree": "Gratuit (Personal)",
  "admin.planHosted": "Găzduit, 29 € / om / lună",
  "admin.planFounder": "Fondator, 19 € / om, 12 luni",
  "admin.planSelfhost": "Self-host, gratuit",
  "admin.st.trial": "Perioadă de test",
  "admin.st.active": "Activ",
  "admin.st.past_due": "Restanță",
  "admin.st.cancelled": "Anulat",
  "admin.implicit": "implicit, nesetat",
  "admin.subTitle": "Abonamentul firmei",
  "admin.subLead": "Pentru clienții care plătesc prin transfer bancar: planul se pune aici de mână. Factura o emite operatorul hubului în sistemul lui de facturare; scrie aici numărul ei.",
  "admin.pricePerSeat": "Preț pe loc (€ / lună)",
  "admin.seatsPaid": "Locuri plătite",
  "admin.periodStart": "Început perioadă",
  "admin.periodEnd": "Sfârșit perioadă",
  "admin.trialEnd": "Testul se termină",
  "admin.invoiceRef": "Factură emisă manual în HoReCaOS (nr.)",
  "admin.note": "Notă",
  "admin.savePlan": "Salvează abonamentul",
  "admin.monthly": "{total} € / lună ({seats} locuri × {price} €)",
  "admin.extendTrial": "Prelungește testul",
  "admin.days": "Zile",
  "admin.history": "Istoricul schimbărilor",
  "admin.historyNone": "Încă nicio schimbare: firma are planul implicit al hubului.",
  "admin.payments": "Plăți online",
  "admin.paymentsOff": "Plățile online nu sunt pornite încă. Clienții plătesc prin transfer bancar, iar factura se emite manual în HoReCaOS.",
  "admin.paymentsNone": "Plățile online sunt pornite, dar firma nu are încă un abonament plătit online.",
  "admin.pickCompany": "Alege o firmă",
  "admin.pickCompanyLead": "Caută firma; din listă deschizi abonamentul ei.",
  "admin.openSub": "Abonament",
  "admin.supportTitle": "Acțiuni de suport",
  "admin.supportLead": "Fiecare acțiune cere un motiv și intră în jurnalul platformei. Persoanele din echipa platformei le schimbă doar un operator.",
  "admin.findAccount": "Găsește un cont",
  "admin.findCompany": "Găsește o firmă",
  "admin.revoke": "Închide toate sesiunile",
  "admin.revokeLead": "Persoana iese din cont pe toate dispozitivele; cheile lor de dispozitiv nu mai sunt valabile.",
  "admin.reset2fa": "Resetează autentificarea în doi pași",
  "admin.reset2faLead": "Pentru cine și-a pierdut telefonul și codurile de rezervă. Persoana primește un e-mail cu motivul; toate sesiunile se închid. Cheile de acces (passkeys) rămân.",
  "admin.confirmEmail": "Scrie adresa contului ca să confirmi",
  "admin.suspendAccount": "Suspendă contul",
  "admin.unsuspendAccount": "Reactivează contul",
  "admin.suspendAccountLead": "Un cont suspendat nu mai poate intra, sesiunile lui se închid, iar runnerele lui sunt refuzate.",
  "admin.suspendCompany": "Suspendă firma",
  "admin.unsuspendCompany": "Reactivează firma",
  "admin.suspendCompanyLead": "Runnerele unei firme suspendate refuză orice cerere (chaturi, angajați AI). Membrii pot intra în cont în continuare.",
  "admin.invites": "Invitații deschise",
  "admin.invitesNone": "Nicio invitație deschisă.",
  "admin.resend": "Retrimite",
  "admin.linkInvite": "link fără e-mail",
  "admin.expired": "expirată",
  "admin.runnersNone": "Niciun runner legat.",
  "admin.membersOf": "Oamenii firmei",
  "admin.staffTitle": "Echipa platformei",
  "admin.staffLead": "Verificatorii văd doar Biblioteca; Suportul vede firmele și conturile și face acțiuni de suport, fără abonamente; Operatorii văd tot. Cei puși prin variabile de mediu (HUB_ADMIN_EMAILS, HUB_STATS_EMAILS, HUB_LIBRARY_REVIEWERS) se schimbă doar acolo.",
  "admin.staffAdd": "Adaugă",
  "admin.staffEmail": "E-mailul contului",
  "admin.staffRole": "Rol",
  "admin.fromEnv": "din mediu",
  "admin.journalLead": "Ce a făcut echipa platformei: cine, ce, asupra cui, de la ce adresă și dispozitiv. Lanț de hash-uri separat de jurnalele firmelor, cu ancoră zilnică.",
  "admin.journalSearch": "Text în acțiune, țintă sau detalii",
  "admin.actor": "E-mailul celui care a acționat",
  "admin.target": "Țintă",
  "admin.chainOk": "Lanțul e intact: {n} rânduri, capăt {hash}.",
  "admin.chainBroken": "Lanțul e rupt la rândul {n}: {reason}",
  "admin.seatsUsed": "Locuri folosite",
  "admin.perSeat": "{price} € / loc",
  "admin.trialUntil": "test până la {date}",
  "admin.seatsN": "{n} locuri",
  "admin.companySummary": "{members} membri, {seats} locuri folosite",
});

Object.assign(DICT.en, {
  "admin.title": "Platform",
  "admin.titleAccent": "admin",
  "admin.privacy": "Metadata only. The Zen team cannot read a company's chats, shared views, memory, files or approval contents, and cannot sign in as anyone. Every page opened here and every action goes into the platform log.",
  "admin.tabs": "Admin sections",
  "admin.tab.cifre": "Stats",
  "admin.tab.firme": "Companies",
  "admin.tab.conturi": "Accounts",
  "admin.tab.abonamente": "Subscriptions",
  "admin.tab.suport": "Support",
  "admin.tab.biblioteca": "Library",
  "admin.tab.jurnal": "Admin log",
  "admin.role.operator": "Operator",
  "admin.role.reviewer": "Reviewer",
  "admin.role.support": "Support",
  "admin.mfaT": "Admin needs a two-factor session",
  "admin.mfa": "You signed in without the code from your authenticator app. Turn on two-factor in Security (if it is off), sign out and sign in again with the code.",
  "admin.search": "Search",
  "admin.searchCompany": "Name, owner's e-mail or ID",
  "admin.searchAccount": "E-mail, name or ID",
  "admin.any": "All",
  "admin.plan": "Plan",
  "admin.status": "Status",
  "admin.suspended": "Suspension",
  "admin.suspendedYes": "Suspended",
  "admin.suspendedNo": "Active",
  "admin.sort": "Order",
  "admin.sortNew": "Newest",
  "admin.sortName": "Name",
  "admin.sortActivity": "Last activity",
  "admin.company": "Company",
  "admin.owner": "Owner",
  "admin.seats": "Seats used / paid",
  "admin.members": "Members",
  "admin.created": "Created",
  "admin.lastActivity": "Last activity",
  "admin.runner": "Runner",
  "admin.packs": "Published packs",
  "admin.none": "Nothing matches the filters.",
  "admin.total": "{n} in total",
  "admin.prev": "Previous",
  "admin.next": "Next",
  "admin.pages": "Pages",
  "admin.page": "Page {n}",
  "admin.details": "Details",
  "admin.account": "Account",
  "admin.companies": "Companies",
  "admin.twofa": "Two-factor",
  "admin.lastSignIn": "Last sign-in",
  "admin.devices": "Devices",
  "admin.sessions": "Sessions",
  "admin.on": "on",
  "admin.off": "off",
  "admin.isSuspended": "Suspended",
  "admin.reason": "Reason (goes into the log)",
  "admin.reasonShort": "Write the reason, at least 5 characters.",
  "admin.done": "Done.",
  "plan.founder": "Founder",
  "admin.planFree": "Free (Personal)",
  "admin.planHosted": "Hosted, 29 € / person / month",
  "admin.planFounder": "Founder, 19 € / person, 12 months",
  "admin.planSelfhost": "Self-host, free",
  "admin.st.trial": "Trial",
  "admin.st.active": "Active",
  "admin.st.past_due": "Overdue",
  "admin.st.cancelled": "Cancelled",
  "admin.implicit": "default, not set",
  "admin.subTitle": "Company subscription",
  "admin.subLead": "For customers who pay by bank transfer: the plan is set here by hand. the hub operator issues the invoice in its invoicing system; enter its number here.",
  "admin.pricePerSeat": "Price per seat (€ / month)",
  "admin.seatsPaid": "Paid seats",
  "admin.periodStart": "Period start",
  "admin.periodEnd": "Period end",
  "admin.trialEnd": "Trial ends",
  "admin.invoiceRef": "Invoice issued by hand in HoReCaOS (no.)",
  "admin.note": "Note",
  "admin.savePlan": "Save the subscription",
  "admin.monthly": "{total} € / month ({seats} seats × {price} €)",
  "admin.extendTrial": "Extend the trial",
  "admin.days": "Days",
  "admin.history": "Change history",
  "admin.historyNone": "No changes yet: the company has the hub's default plan.",
  "admin.payments": "Online payments",
  "admin.paymentsOff": "Online payments are not on yet. Customers pay by bank transfer and the invoice is issued by hand in HoReCaOS.",
  "admin.paymentsNone": "Online payments are on, but the company has no subscription paid online yet.",
  "admin.pickCompany": "Choose a company",
  "admin.pickCompanyLead": "Search for the company; open its subscription from the list.",
  "admin.openSub": "Subscription",
  "admin.supportTitle": "Support actions",
  "admin.supportLead": "Each action needs a reason and goes into the platform log. Only an operator changes people on the platform team.",
  "admin.findAccount": "Find an account",
  "admin.findCompany": "Find a company",
  "admin.revoke": "End all sessions",
  "admin.revokeLead": "The person is signed out on every device; their device keys stop being valid.",
  "admin.reset2fa": "Reset two-factor authentication",
  "admin.reset2faLead": "For someone who lost their phone and their recovery codes. The person gets an e-mail with the reason; every session ends. Passkeys stay.",
  "admin.confirmEmail": "Type the account's address to confirm",
  "admin.suspendAccount": "Suspend the account",
  "admin.unsuspendAccount": "Reactivate the account",
  "admin.suspendAccountLead": "A suspended account cannot sign in, its sessions end and its runners are refused.",
  "admin.suspendCompany": "Suspend the company",
  "admin.unsuspendCompany": "Reactivate the company",
  "admin.suspendCompanyLead": "The runners of a suspended company refuse every request (chats, AI staff). Members can still sign in.",
  "admin.invites": "Open invitations",
  "admin.invitesNone": "No open invitations.",
  "admin.resend": "Resend",
  "admin.linkInvite": "link without e-mail",
  "admin.expired": "expired",
  "admin.runnersNone": "No runner linked.",
  "admin.membersOf": "The company's people",
  "admin.staffTitle": "Platform team",
  "admin.staffLead": "Reviewers see only the Library; Support sees companies and accounts and takes support actions, without subscriptions; Operators see everything. Those set through environment variables (HUB_ADMIN_EMAILS, HUB_STATS_EMAILS, HUB_LIBRARY_REVIEWERS) are changed only there.",
  "admin.staffAdd": "Add",
  "admin.staffEmail": "Account e-mail",
  "admin.staffRole": "Role",
  "admin.fromEnv": "from environment",
  "admin.journalLead": "What the platform team did: who, what, to whom, from which address and device. A hash chain separate from the company logs, with a daily anchor.",
  "admin.journalSearch": "Text in the action, target or details",
  "admin.actor": "E-mail of whoever acted",
  "admin.target": "Target",
  "admin.chainOk": "The chain is intact: {n} rows, head {hash}.",
  "admin.chainBroken": "The chain is broken at row {n}: {reason}",
  "admin.seatsUsed": "Seats used",
  "admin.perSeat": "{price} € / seat",
  "admin.trialUntil": "trial until {date}",
  "admin.seatsN": "{n} seats",
  "admin.companySummary": "{members} members, {seats} seats used",
});

const ADMIN_TABS = [
  ["cifre", "stats", "chart"],
  ["firme", "companies", "company"],
  ["conturi", "accounts", "team"],
  ["abonamente", "billing.view", "plan"],
  ["suport", "support", "key"],
  ["biblioteca", "library", "packs"],
  ["jurnal", "journal", "clock"],
];
const adminCan = (cap) => state.me?.admin?.caps?.includes(cap) === true;
const adminPath = (path, params = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== "" && value !== null && value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
};

/** Runs a button's action without a spinner: the button is disabled, the error goes under it. */
async function run(button, errorEl, fn) {
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  if (errorEl) errorEl.textContent = "";
  try {
    return await fn();
  } catch (error) {
    if (handleAuth(error)) return undefined;
    if (errorEl) errorEl.textContent = messageOf(error);
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

/** Page numbers: first, the ones around the current page, last; the hub pages on its side. */
function pager(data, onGo) {
  if (data.pages <= 1) return h("p", { class: "small muted", text: t("admin.total", { n: fmtNum(data.total) }) });
  const numbers = new Set([1, data.pages, data.page - 1, data.page, data.page + 1].filter((n) => n >= 1 && n <= data.pages));
  const sorted = [...numbers].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((n, index) => {
    if (index > 0 && n - sorted[index - 1] > 1) items.push(h("span", { class: "pager-gap", "aria-hidden": "true", text: "…" }));
    items.push(h("button", { type: "button", class: "pager-n", "aria-current": n === data.page ? "page" : null, "aria-label": t("admin.page", { n }), text: String(n), onclick: () => onGo(n) }));
  });
  return h(
    "nav",
    { class: "pager", "aria-label": t("admin.pages") },
    h("button", { type: "button", class: "btn small quiet", disabled: data.page <= 1, onclick: () => onGo(data.page - 1) }, t("admin.prev")),
    items,
    h("button", { type: "button", class: "btn small quiet", disabled: data.page >= data.pages, onclick: () => onGo(data.page + 1) }, t("admin.next")),
    h("span", { class: "small muted", text: t("admin.total", { n: fmtNum(data.total) }) }),
  );
}

/** A table whose rows come from the hub page by page; skeleton rows while a page loads. */
function pagedTable({ columns, fetchPage, row, empty }) {
  const tbody = h("tbody");
  const foot = h("div", { class: "pager-wrap" });
  const error = h("p", { class: "error", role: "alert" });
  const wrap = h("div", {}, h("div", { class: "table-wrap" }, h("table", { class: "stackable admin-table" }, h("thead", {}, h("tr", {}, columns.map((label) => h("th", { scope: "col", text: label })))), tbody)), foot, error);
  let current = 1;
  const show = async (page) => {
    current = page;
    tbody.replaceChildren(...Array.from({ length: 5 }, () => h("tr", { class: "bone-row" }, columns.map(() => h("td", {}, bone("b-line"))))));
    error.textContent = "";
    try {
      const data = await fetchPage(page);
      tbody.replaceChildren(...(data.items.length === 0 ? [h("tr", {}, h("td", { colspan: String(columns.length), class: "muted first", text: empty }))] : data.items.map(row)));
      foot.replaceChildren(pager(data, show));
    } catch (error_) {
      if (handleAuth(error_)) return;
      tbody.replaceChildren();
      foot.replaceChildren();
      error.textContent = messageOf(error_);
    }
  };
  return { el: wrap, show, reload: () => show(current) };
}

const labelled = (label, control) => h("label", {}, label, control);
const select = (label, options, value = "") =>
  h("select", { "aria-label": label }, options.map(([v, text]) => h("option", { value: v, text, selected: v === value ? true : null })));
const reasonInput = () => h("input", { type: "text", maxlength: "500", autocomplete: "off", placeholder: t("admin.reasonShort") });
const stateChip = (status) => h("span", { class: `chip ${status === "active" ? "ink" : status === "past_due" ? "loud" : "line"}`, text: t(`admin.st.${status}`) });
const planName = (plan) => (plan === "founder" ? t("plan.founder") : plan === "free" ? t("plan.free") : t(`plan.${plan}`));
const roleChips = (roles) => roles.map((role) => h("span", { class: "chip line", text: t(`admin.role.${role}`) }));
const suspendedChip = (suspended) => (suspended ? h("span", { class: "chip loud", title: suspended.reason, text: t("admin.isSuspended") }) : null);

function pageAdmin(main, mine) {
  const segments = location.pathname.split("/").filter(Boolean);
  const allowed = ADMIN_TABS.filter(([, cap]) => adminCan(cap));
  const wanted = segments[2] ?? "";
  const tab = allowed.find(([name]) => name === wanted)?.[0] ?? allowed[0]?.[0];
  if (tab === undefined) return go("acasa", { replace: true });
  if (tab !== wanted) {
    history.replaceState(null, "", `/app/admin/${tab}${location.hash}`);
  }
  const tabs = h(
    "nav",
    { class: "admin-tabs", "aria-label": t("admin.tabs") },
    allowed.map(([name, , iconName]) => h("a", { href: `/app/admin/${name}`, "aria-current": name === tab ? "page" : null }, icon(iconName), t(`admin.tab.${name}`))),
  );
  const privacy = h("p", { class: "note admin-privacy" }, icon("lock"), h("span", { text: t("admin.privacy") }));
  const panel = h("div", { class: "admin-panel" });
  main.replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, title(t("admin.title"), t("admin.titleAccent")), h("p", { class: "sub" }, roleChips(state.me.admin.roles)))),
    tabs,
    privacy,
    panel,
  );
  if (!state.me.twoFactor.sessionVerified) {
    return panel.replaceChildren(h("section", { class: "card" }, emptyState("lock", t("admin.mfaT"), t("admin.mfa"), h("a", { class: "btn primary", href: "/app/securitate" }, icon("security"), t("nav.security")), signOutButton())));
  }
  const draw = { cifre: adminStats, firme: adminCompanies, conturi: adminAccounts, abonamente: adminSubscriptions, suport: adminSupport, biblioteca: adminLibrary, jurnal: adminJournal }[tab];
  draw(panel, mine);
}

function signOutButton() {
  return h("button", { class: "btn", type: "button", onclick: (event) => signOut(event.currentTarget) }, icon("logout"), t("nav.logout"));
}

function adminStats(panel, mine) {
  pageStats(panel, mine);
}

// ---- Firme

function companyFilters(onSearch, billing) {
  const q = h("input", { type: "search", placeholder: t("admin.searchCompany"), "aria-label": t("admin.search") });
  const plan = select(t("admin.plan"), [["", t("admin.any")], ["hosted", t("plan.hosted")], ["founder", t("plan.founder")], ["free", t("plan.free")], ["selfhost", t("plan.selfhost")]]);
  const status = select(t("admin.status"), [["", t("admin.any")], ...["trial", "active", "past_due", "cancelled"].map((st) => [st, t(`admin.st.${st}`)])]);
  const suspended = select(t("admin.suspended"), [["", t("admin.any")], ["no", t("admin.suspendedNo")], ["yes", t("admin.suspendedYes")]]);
  const sort = select(t("admin.sort"), [["", t("admin.sortNew")], ["activity", t("admin.sortActivity")], ["name", t("admin.sortName")]]);
  const button = h("button", { class: "btn primary", type: "submit" }, icon("search"), t("admin.search"));
  const form = h(
    "form",
    { class: "form admin-filters", role: "search", novalidate: true },
    h("div", { class: "form-grid" }, h("label", { class: "wide-2" }, t("admin.search"), q), billing ? labelled(t("admin.plan"), plan) : null, billing ? labelled(t("admin.status"), status) : null, labelled(t("admin.suspended"), suspended), labelled(t("admin.sort"), sort)),
    h("div", { class: "row" }, button),
  );
  const values = () => ({ q: q.value.trim(), plan: billing ? plan.value : "", status: billing ? status.value : "", suspended: suspended.value, sort: sort.value });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSearch(values());
  });
  return { form, values };
}

function companyRowEl(company, opts = {}) {
  const billing = adminCan("billing.view");
  const runner = company.runners === 0 ? h("span", { class: "muted", text: "-" }) : h("span", { class: `chip ${company.runnersOnline > 0 ? "ink" : "line"}`, text: `${company.runnersOnline > 0 ? t("common.online") : t("common.offline")} · ${company.runnersOnline}/${company.runners}` });
  return h(
    "tr",
    {},
    h("td", { class: "first" }, h("a", { href: opts.href ? opts.href(company) : `/app/admin/firme#${encodeURIComponent(company.id)}`, title: company.id, text: company.name }), " ", suspendedChip(company.suspended)),
    h("td", { class: "small" }, company.owner ? h("span", { class: "admin-owner", title: company.owner.name, text: company.owner.email }) : "-"),
    billing ? h("td", { class: "small" }, h("div", { class: "admin-plan" }, h("span", { class: "chip line", text: planName(company.plan) }), company.planSet ? stateChip(company.status) : null), h("span", { class: "muted", text: `${t("admin.perSeat", { price: company.pricePerSeat })}${company.planSet ? "" : ` · ${t("admin.implicit")}`}` })) : null,
    h("td", { class: "small num", text: billing ? `${company.seatsUsed} / ${company.seatsPaid}` : String(company.seatsUsed) }),
    h("td", { class: "small num", text: String(company.members) }),
    h("td", { class: "small", text: fmtDate(company.createdAt) }),
    h("td", { class: "small", text: fmtWhen(company.lastActivity) }),
    h("td", { class: "small" }, runner),
    h("td", { class: "small num", text: String(company.packsPublished) }),
  );
}

const companyColumns = () => [t("admin.company"), t("admin.owner"), adminCan("billing.view") ? t("admin.plan") : null, adminCan("billing.view") ? t("admin.seats") : t("admin.seatsUsed"), t("admin.members"), t("admin.created"), t("admin.lastActivity"), t("admin.runner"), t("admin.packs")].filter(Boolean);

function companiesList(opts = {}) {
  const billing = adminCan("billing.view");
  let filters = {};
  const table = pagedTable({
    columns: companyColumns(),
    fetchPage: (page) => api("GET", adminPath("/v1/admin/companies", { ...filters, page })),
    row: (company) => companyRowEl(company, opts),
    empty: t("admin.none"),
  });
  const { form } = companyFilters((values) => {
    filters = values;
    table.show(1);
  }, billing);
  table.show(1);
  return [h("section", { class: "card full" }, form), h("section", { class: "card full" }, table.el)];
}

function adminCompanies(panel, mine) {
  const id = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  if (id !== "") return companyDetail(panel, mine, id);
  panel.replaceChildren(...companiesList());
}

function companyDetail(panel, mine, id) {
  load(
    panel,
    mine,
    [headSkeleton(), h("div", { class: "cols" }, cardSkeleton(5), cardSkeleton(4))],
    () => api("GET", `/v1/admin/companies/${encodeURIComponent(id)}`),
    (data) => {
      const company = data.company;
      const facts = h(
        "div",
        { class: "stats admin-stats" },
        statTile(t("admin.members"), fmtNum(company.members)),
        statTile(adminCan("billing.view") ? t("admin.seats") : t("admin.seatsUsed"), adminCan("billing.view") ? `${company.seatsUsed} / ${company.seatsPaid}` : String(company.seatsUsed)),
        statTile(t("admin.runner"), `${company.runnersOnline} / ${company.runners}`),
        statTile(t("admin.packs"), fmtNum(company.packsPublished)),
        statTile(t("admin.lastActivity"), fmtWhen(company.lastActivity)),
        adminCan("billing.view") ? statTile(t("admin.plan"), `${planName(company.plan)} · ${t(`admin.st.${company.status}`)}`) : null,
      );
      const members = h(
        "section",
        { class: "card" },
        cardHead(t("admin.membersOf"), "team"),
        h(
          "ul",
          { class: "list" },
          data.members.map((member) =>
            h("li", {}, avatar(member.name, "sm"), h("div", { class: "grow" }, h("div", { class: "title" }, member.name, " ", member.suspendedAt ? h("span", { class: "chip loud", text: t("admin.isSuspended") }) : null), h("div", { class: "meta", text: `${member.email} · ${t(`role.${member.role}`)} · ${fmtDate(member.joinedAt)}` })), adminCan("support") ? h("a", { class: "btn small quiet", href: `/app/admin/suport#u:${encodeURIComponent(member.userId)}` }, t("admin.tab.suport")) : null),
          ),
        ),
      );
      const runners = h(
        "section",
        { class: "card" },
        cardHead(t("admin.runner"), "server"),
        data.runners.length === 0 ? h("p", { class: "muted", text: t("admin.runnersNone") }) : h("ul", { class: "list" }, data.runners.map((runner) => h("li", {}, icon("server"), h("div", { class: "grow" }, h("div", { class: "title", text: runner.name }), h("div", { class: "meta", text: `${runner.ownerEmail} · ${fmtWhen(runner.lastSeenAt)}` })), h("span", { class: `chip ${runner.online ? "ink" : "line"}`, text: runner.online ? t("common.online") : t("common.offline") })))),
      );
      append(panel, [
        head(h("h2", { class: "admin-h", text: company.name }), h("span", {}, company.owner ? `${company.owner.name} · ${company.owner.email} · ` : "", h("span", { class: "mono", text: company.id }), " ", suspendedChip(company.suspended)), h("a", { class: "btn", href: "/app/admin/firme" }, t("admin.tab.firme")), adminCan("billing.view") ? h("a", { class: "btn primary", href: `/app/admin/abonamente#${encodeURIComponent(company.id)}` }, icon("plan"), t("admin.openSub")) : null, adminCan("support") ? h("a", { class: "btn", href: `/app/admin/suport#c:${encodeURIComponent(company.id)}` }, icon("key"), t("admin.tab.suport")) : null),
        h("section", { class: "card full" }, facts, company.suspended ? h("p", { class: "error", text: `${t("admin.isSuspended")}: ${company.suspended.reason} · ${fmtWhen(company.suspended.at)}` }) : null),
        h("div", { class: "cols" }, members, runners, invitesCard(data.invites)),
      ]);
    },
  );
}

function statTile(label, value) {
  return h("div", { class: "stat" }, h("div", { class: "n", text: value }), h("div", { class: "l", text: label }));
}

function invitesCard(invites) {
  const error = h("p", { class: "error", role: "alert" });
  const list = invites.length === 0
    ? h("p", { class: "muted", text: t("admin.invitesNone") })
    : h(
        "ul",
        { class: "list" },
        invites.map((invite) => {
          const reason = reasonInput();
          const button = h("button", { class: "btn small", type: "button" }, icon("refresh"), t("admin.resend"));
          const done = h("span", { class: "small ok-line", role: "status" });
          button.addEventListener("click", () =>
            run(button, error, async () => {
              await api("POST", `/v1/admin/invites/${encodeURIComponent(invite.id)}/resend`, { reason: reason.value.trim() });
              done.textContent = t("admin.done");
              reason.value = "";
            }),
          );
          return h(
            "li",
            { class: "admin-li" },
            h("div", { class: "grow" }, h("div", { class: "title", text: invite.email ?? t("admin.linkInvite") }), h("div", { class: "meta", text: `${t(`role.${invite.role}`)} · ${fmtDate(invite.createdAt)}${invite.expired ? ` · ${t("admin.expired")}` : ""}` })),
            invite.email && adminCan("support") ? h("div", { class: "admin-inline" }, h("label", { class: "visually-hidden", text: t("admin.reason") }), reason, button, done) : null,
          );
        }),
      );
  return h("section", { class: "card" }, cardHead(t("admin.invites"), "mail"), list, error);
}

// ---- Conturi

function accountRowEl(account) {
  return h(
    "tr",
    {},
    h("td", { class: "first" }, h("span", { class: "state" }, avatar(account.name, "sm"), h("span", {}, account.name, " ", suspendedChip(account.suspended), roleChips(account.staff ?? []), h("br"), h("span", { class: "small muted", text: account.email })))),
    h("td", { class: "small" }, account.companies.length === 0 ? h("span", { class: "muted", text: "-" }) : account.companies.map((company, index) => [index ? ", " : "", h("a", { href: `/app/admin/firme#${encodeURIComponent(company.id)}`, text: company.name }), h("span", { class: "muted", text: ` (${t(`role.${company.role}`)})` })])),
    h("td", { class: "small" }, h("span", { class: `chip ${account.twoFactor ? "ink" : "line"}`, text: account.twoFactor ? t("admin.on") : t("admin.off") })),
    h("td", { class: "small", text: fmtWhen(account.lastSignInAt) }),
    h("td", { class: "small num", text: `${account.devices}` }),
    h("td", { class: "small num", text: `${account.sessions}` }),
    h("td", { class: "small actions" }, adminCan("support") ? h("a", { class: "btn small quiet", href: `/app/admin/suport#u:${encodeURIComponent(account.id)}` }, t("admin.tab.suport")) : null),
  );
}

function adminAccounts(panel) {
  let filters = {};
  const table = pagedTable({
    columns: [t("admin.account"), t("admin.companies"), t("admin.twofa"), t("admin.lastSignIn"), t("admin.devices"), t("admin.sessions"), ""],
    fetchPage: (page) => api("GET", adminPath("/v1/admin/accounts", { ...filters, page })),
    row: accountRowEl,
    empty: t("admin.none"),
  });
  const q = h("input", { type: "search", placeholder: t("admin.searchAccount"), "aria-label": t("admin.search") });
  const twofa = select(t("admin.twofa"), [["", t("admin.any")], ["on", t("admin.on")], ["off", t("admin.off")]]);
  const suspended = select(t("admin.suspended"), [["", t("admin.any")], ["no", t("admin.suspendedNo")], ["yes", t("admin.suspendedYes")]]);
  const form = h("form", { class: "form admin-filters", role: "search", novalidate: true }, h("div", { class: "form-grid" }, h("label", { class: "wide-2" }, t("admin.search"), q), labelled(t("admin.twofa"), twofa), labelled(t("admin.suspended"), suspended)), h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, icon("search"), t("admin.search"))));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    filters = { q: q.value.trim(), twofa: twofa.value, suspended: suspended.value };
    table.show(1);
  });
  table.show(1);
  panel.replaceChildren(h("section", { class: "card full" }, form), h("section", { class: "card full" }, table.el));
}

// ---- Abonamente

function adminSubscriptions(panel, mine) {
  const id = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  if (id === "") {
    panel.replaceChildren(h("section", { class: "card full" }, cardHead(t("admin.pickCompany"), "plan"), h("p", { class: "lede", text: t("admin.pickCompanyLead") })), ...companiesList({ href: (company) => `/app/admin/abonamente#${encodeURIComponent(company.id)}` }));
    return;
  }
  load(
    panel,
    mine,
    [headSkeleton(), h("div", { class: "cols side-right" }, cardSkeleton(8), cardSkeleton(4))],
    () => api("GET", `/v1/admin/subscriptions/${encodeURIComponent(id)}`),
    (data) => drawSubscription(panel, data),
  );
}

function drawSubscription(panel, data) {
  const sub = data.subscription;
  const editable = adminCan("billing.edit");
  const plan = select(t("admin.plan"), [["hosted", t("admin.planHosted")], ["founder", t("admin.planFounder")], ["free", t("admin.planFree")], ["selfhost", t("admin.planSelfhost")]], sub.plan);
  const price = h("input", { type: "number", min: "0", max: "1000", step: "1", inputmode: "numeric", value: String(sub.pricePerSeat) });
  const seats = h("input", { type: "number", min: "0", max: "100000", step: "1", inputmode: "numeric", value: String(sub.seats || data.company.seatsUsed) });
  const status = select(t("admin.status"), ["trial", "active", "past_due", "cancelled"].map((st) => [st, t(`admin.st.${st}`)]), sub.set ? sub.status : "active");
  const start = h("input", { type: "date", value: sub.periodStart ?? "" });
  const end = h("input", { type: "date", value: sub.periodEnd ?? "" });
  const trialEnd = h("input", { type: "date", value: sub.trialEnd ?? "" });
  const invoice = h("input", { type: "text", maxlength: "60", placeholder: "ZEN 0001", value: sub.invoiceRef ?? "" });
  const note = h("textarea", { rows: "3", maxlength: "500" });
  note.value = sub.note ?? "";
  const monthly = h("p", { class: "admin-total", role: "status" });
  const showTotal = () => {
    const total = (Number(price.value) || 0) * (Number(seats.value) || 0);
    monthly.textContent = t("admin.monthly", { total: fmtNum(total), seats: seats.value || 0, price: price.value || 0 });
  };
  plan.addEventListener("change", () => {
    price.value = String(data.prices[plan.value] ?? 0);
    if (plan.value === "founder" && start.value === "") start.value = new Date().toISOString().slice(0, 10);
    if (plan.value === "founder" && end.value === "") end.value = "";
    showTotal();
  });
  price.addEventListener("input", showTotal);
  seats.addEventListener("input", showTotal);
  showTotal();
  for (const control of [plan, price, seats, status, start, end, trialEnd, invoice, note]) control.disabled = !editable;
  const error = h("p", { class: "error", role: "alert" });
  const saved = h("p", { class: "ok-line", role: "status" });
  const save = h("button", { class: "btn primary", type: "submit" }, icon("check"), t("admin.savePlan"));
  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("p", { class: "lede", text: t("admin.subLead") }),
    h("div", { class: "form-grid" }, labelled(t("admin.plan"), plan), labelled(t("admin.pricePerSeat"), price), labelled(t("admin.seatsPaid"), seats), labelled(t("admin.status"), status), labelled(t("admin.periodStart"), start), labelled(t("admin.periodEnd"), end), labelled(t("admin.trialEnd"), trialEnd), labelled(t("admin.invoiceRef"), invoice), h("label", { class: "wide" }, t("admin.note"), note)),
    monthly,
    editable ? h("div", { class: "row" }, save) : null,
    error,
    saved,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(save, error, async () => {
      const answer = await api("PUT", `/v1/admin/subscriptions/${encodeURIComponent(data.company.id)}`, {
        plan: plan.value,
        pricePerSeat: Number(price.value),
        seats: Number(seats.value),
        status: status.value,
        periodStart: start.value || null,
        periodEnd: end.value || null,
        trialEnd: trialEnd.value || null,
        invoiceRef: invoice.value.trim() || null,
        note: note.value.trim(),
      });
      drawSubscription(panel, { ...data, subscription: answer.subscription, history: answer.history });
    });
  });
  const days = h("input", { type: "number", min: "1", max: "90", value: "14", inputmode: "numeric" });
  const trialReason = reasonInput();
  const trialButton = h("button", { class: "btn", type: "button" }, icon("clock"), t("admin.extendTrial"));
  const trialError = h("p", { class: "error", role: "alert" });
  trialButton.addEventListener("click", () =>
    run(trialButton, trialError, async () => {
      const answer = await api("POST", `/v1/admin/subscriptions/${encodeURIComponent(data.company.id)}/trial`, { days: Number(days.value), reason: trialReason.value.trim() });
      drawSubscription(panel, { ...data, subscription: answer.subscription, history: answer.history });
    }),
  );
  const trialCard = editable && sub.plan !== "free" && sub.plan !== "selfhost"
    ? h("section", { class: "card" }, cardHead(t("admin.extendTrial"), "clock"), h("div", { class: "form" }, h("div", { class: "form-grid" }, labelled(t("admin.days"), days), h("label", { class: "wide" }, t("admin.reason"), trialReason)), h("div", { class: "row" }, trialButton), trialError))
    : null;
  const history = h(
    "section",
    { class: "card" },
    cardHead(t("admin.history"), "activity"),
    data.history.length === 0
      ? h("p", { class: "muted", text: t("admin.historyNone") })
      : h(
          "ul",
          { class: "list" },
          data.history.map((entry) =>
            h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: `${planName(entry.after.plan)} · ${t(`admin.st.${entry.after.status}`)} · ${entry.after.seats} × ${entry.after.pricePerSeat} €${entry.after.invoiceRef ? ` · ${entry.after.invoiceRef}` : ""}` }), h("div", { class: "meta", text: `${fmtWhen(entry.changedAt)} · ${entry.changedBy ?? ""}${entry.reason ? ` · ${entry.reason}` : ""}${entry.after.trialEnd && entry.action === "trial" ? ` · ${t("admin.trialUntil", { date: fmtDate(entry.after.trialEnd) })}` : ""}` }))),
          ),
        ),
  );
  const payments = data.payments;
  const paymentsCard = h(
    "section",
    { class: "card" },
    cardHead(t("admin.payments"), "plan"),
    !payments.available
      ? h("p", { class: "note" }, icon("lock"), h("span", { text: t("admin.paymentsOff") }))
      : payments.account === null
        ? h("p", { class: "muted", text: t("admin.paymentsNone") })
        : [
            h("p", { class: "small", text: `${payments.account.plan} · ${payments.account.status} · ${t("admin.seatsN", { n: payments.account.seats })}` }),
            h("ul", { class: "list" }, payments.invoices.map((invoice) => h("li", {}, h("div", { class: "grow" }, h("div", { class: "title", text: `${(invoice.amountCents / 100).toFixed(2)} ${String(invoice.currency).toUpperCase()} · ${invoice.fiscalSeries ?? ""} ${invoice.fiscalNumber ?? ""}` }), h("div", { class: "meta", text: `${invoice.kind} · fiscal: ${invoice.fiscalStatus}${invoice.efacturaStatus ? ` · e-Factura: ${invoice.efacturaStatus}` : ""}` }))))),
          ],
  );
  panel.replaceChildren(
    head(h("h2", { class: "admin-h", text: data.company.name }), `${data.company.owner ? `${data.company.owner.email} · ` : ""}${t("admin.companySummary", { members: data.company.members, seats: data.company.seatsUsed })}${sub.set ? "" : ` · ${t("admin.implicit")}`}`, h("a", { class: "btn", href: "/app/admin/abonamente" }, t("admin.pickCompany")), h("a", { class: "btn", href: `/app/admin/firme#${encodeURIComponent(data.company.id)}` }, t("admin.details"))),
    h("div", { class: "cols side-right" }, h("section", { class: "card" }, cardHead(t("admin.subTitle"), "plan", sub.set ? stateChip(sub.status) : h("span", { class: "chip line", text: t("admin.implicit") })), form), h("div", { class: "stack" }, trialCard, paymentsCard, history)),
  );
}

// ---- Suport

/** A form with a reason (and, optionally, a typed confirmation) that runs one support action. */
function supportAction({ heading, lead, iconName, label, danger, confirmText, action }) {
  const reason = reasonInput();
  const confirm = confirmText ? h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: confirmText }) : null;
  const button = h("button", { class: `btn ${danger ? "loud" : "primary"}`, type: "submit", disabled: confirmText ? true : null }, icon(iconName), label);
  const error = h("p", { class: "error", role: "alert" });
  const done = h("p", { class: "ok-line", role: "status" });
  confirm?.addEventListener("input", () => (button.disabled = confirm.value.trim().toLowerCase() !== confirmText.toLowerCase()));
  const form = h("form", { class: "form", novalidate: true }, h("p", { class: "lede", text: lead }), h("label", {}, t("admin.reason"), reason), confirm ? h("label", {}, t("admin.confirmEmail"), confirm) : null, h("div", { class: "row" }, button), error, done);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(button, error, async () => {
      await action({ reason: reason.value.trim(), confirm: confirm?.value.trim() ?? "" });
      done.textContent = t("admin.done");
      reason.value = "";
      if (confirm) {
        confirm.value = "";
        button.disabled = true;
      }
    });
  });
  return h("section", { class: "card" }, cardHead(heading, iconName), form);
}

function finder(kind, onPick) {
  const q = h("input", { type: "search", placeholder: kind === "u" ? t("admin.searchAccount") : t("admin.searchCompany"), "aria-label": t("admin.search") });
  const out = h("ul", { class: "list admin-found" });
  const error = h("p", { class: "error", role: "alert" });
  const button = h("button", { class: "btn", type: "submit" }, icon("search"), t("admin.search"));
  const form = h("form", { class: "form", role: "search", novalidate: true }, h("div", { class: "admin-inline" }, q, button), error, out);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    out.replaceChildren(...bones(3, "b-row"));
    run(button, error, async () => {
      const data = await api("GET", adminPath(kind === "u" ? "/v1/admin/accounts" : "/v1/admin/companies", { q: q.value.trim(), per: 8 }));
      out.replaceChildren(
        ...(data.items.length === 0
          ? [h("li", { class: "muted", text: t("admin.none") })]
          : data.items.map((item) => h("li", {}, kind === "u" ? avatar(item.name, "sm") : h("span", { class: "co-tile", text: initials(item.name) }), h("div", { class: "grow" }, h("div", { class: "title" }, item.name, " ", suspendedChip(item.suspended)), h("div", { class: "meta", text: kind === "u" ? item.email : (item.owner?.email ?? item.id) })), h("button", { class: "btn small", type: "button", onclick: () => onPick(item) }, t("admin.details"))))),
      );
    }).then(() => {
      if (error.textContent) out.replaceChildren();
    });
  });
  return form;
}

function adminSupport(panel, mine) {
  const hash = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "";
  const pick = (kind, id) => {
    history.replaceState(null, "", `/app/admin/suport#${kind}:${encodeURIComponent(id)}`);
    adminSupport(panel, mine);
  };
  const finders = h(
    "div",
    { class: "cols" },
    h("section", { class: "card" }, cardHead(t("admin.findAccount"), "user"), finder("u", (item) => pick("u", item.id))),
    h("section", { class: "card" }, cardHead(t("admin.findCompany"), "company"), finder("c", (item) => pick("c", item.id))),
  );
  const lead = h("section", { class: "card full" }, cardHead(t("admin.supportTitle"), "key"), h("p", { class: "lede", text: t("admin.supportLead") }));
  if (hash.startsWith("u:")) {
    return load(panel, mine, [cardSkeleton(2, { cls: "full" }), h("div", { class: "cols" }, cardSkeleton(4), cardSkeleton(4))], () => api("GET", adminPath("/v1/admin/accounts", { q: hash.slice(2), per: 5 })), (data) => {
      const account = data.items.find((item) => item.id === hash.slice(2));
      if (account === undefined) return append(panel, [lead, h("section", { class: "card" }, emptyState("user", t("admin.none"), "")), finders]);
      drawAccountSupport(panel, account, () => adminSupport(panel, ticket), [lead, finders]);
    });
  }
  if (hash.startsWith("c:")) {
    return load(panel, mine, [cardSkeleton(2, { cls: "full" }), h("div", { class: "cols" }, cardSkeleton(4), cardSkeleton(4))], () => api("GET", `/v1/admin/companies/${encodeURIComponent(hash.slice(2))}`), (data) => drawCompanySupport(panel, data, () => adminSupport(panel, ticket), [lead, finders]));
  }
  panel.replaceChildren(lead, finders);
}

function drawAccountSupport(panel, account, refresh, extra) {
  const path = (suffix) => `/v1/admin/accounts/${encodeURIComponent(account.id)}${suffix}`;
  const summary = h(
    "section",
    { class: "card full" },
    h("div", { class: "admin-who" }, avatar(account.name), h("div", { class: "grow" }, h("b", { class: "staff-name", text: account.name }), " ", suspendedChip(account.suspended), roleChips(account.staff ?? []), h("div", { class: "meta", text: `${account.email} · ${t("admin.twofa")}: ${account.twoFactor ? t("admin.on") : t("admin.off")} · ${t("admin.lastSignIn")}: ${fmtWhen(account.lastSignInAt)} · ${account.sessions} ${t("admin.sessions").toLowerCase()} · ${account.devices} ${t("admin.devices").toLowerCase()}` }), h("div", { class: "meta" }, account.companies.map((company, index) => [index ? ", " : "", h("a", { href: `/app/admin/firme#${encodeURIComponent(company.id)}`, text: company.name })])))),
    account.suspended ? h("p", { class: "error", text: `${t("admin.isSuspended")}: ${account.suspended.reason} · ${fmtWhen(account.suspended.at)}` }) : null,
  );
  const actions = h(
    "div",
    { class: "cols" },
    supportAction({ heading: t("admin.revoke"), lead: t("admin.revokeLead"), iconName: "logout", label: t("admin.revoke"), action: ({ reason }) => api("POST", path("/sessions/revoke"), { reason }).then(refresh) }),
    supportAction({ heading: t("admin.reset2fa"), lead: t("admin.reset2faLead"), iconName: "security", label: t("admin.reset2fa"), danger: true, confirmText: account.email, action: ({ reason, confirm }) => api("POST", path("/two-factor/reset"), { reason, confirm }).then(refresh) }),
    account.suspended
      ? supportAction({ heading: t("admin.unsuspendAccount"), lead: t("admin.suspendAccountLead"), iconName: "check", label: t("admin.unsuspendAccount"), action: ({ reason }) => api("POST", path("/unsuspend"), { reason }).then(refresh) })
      : supportAction({ heading: t("admin.suspendAccount"), lead: t("admin.suspendAccountLead"), iconName: "ban", label: t("admin.suspendAccount"), danger: true, action: ({ reason }) => api("POST", path("/suspend"), { reason }).then(refresh) }),
  );
  panel.replaceChildren(summary, actions, ...extra);
}

function drawCompanySupport(panel, data, refresh, extra) {
  const company = data.company;
  const path = (suffix) => `/v1/admin/companies/${encodeURIComponent(company.id)}${suffix}`;
  const summary = h(
    "section",
    { class: "card full" },
    h("div", { class: "admin-who" }, h("span", { class: "co-tile", text: initials(company.name) }), h("div", { class: "grow" }, h("b", { class: "staff-name", text: company.name }), " ", suspendedChip(company.suspended), h("div", { class: "meta", text: `${company.owner?.email ?? ""} · ${company.members} ${t("admin.members").toLowerCase()} · ${t("admin.runner")}: ${company.runnersOnline}/${company.runners}` })), h("a", { class: "btn small", href: `/app/admin/firme#${encodeURIComponent(company.id)}` }, t("admin.details"))),
    company.suspended ? h("p", { class: "error", text: `${t("admin.isSuspended")}: ${company.suspended.reason} · ${fmtWhen(company.suspended.at)}` }) : null,
  );
  const suspend = company.suspended
    ? supportAction({ heading: t("admin.unsuspendCompany"), lead: t("admin.suspendCompanyLead"), iconName: "check", label: t("admin.unsuspendCompany"), action: ({ reason }) => api("POST", path("/unsuspend"), { reason }).then(refresh) })
    : supportAction({ heading: t("admin.suspendCompany"), lead: t("admin.suspendCompanyLead"), iconName: "ban", label: t("admin.suspendCompany"), danger: true, action: ({ reason }) => api("POST", path("/suspend"), { reason }).then(refresh) });
  panel.replaceChildren(summary, h("div", { class: "cols" }, suspend, invitesCard(data.invites)), ...extra);
}

// ---- Bibliotecă: the review queue plus the platform staff

function adminLibrary(panel, mine) {
  pageReview(panel, mine, { embedded: true, after: adminCan("staff") ? platformStaffCard() : null });
}

function platformStaffCard() {
  const card = h("section", { class: "card full" }, cardHead(t("admin.staffTitle"), "team"), h("p", { class: "lede", text: t("admin.staffLead") }), ...bones(3, "b-row"));
  const draw = (staff) => {
    const email = h("input", { type: "email", autocomplete: "off", placeholder: t("ph.email"), "aria-label": t("admin.staffEmail") });
    const role = select(t("admin.staffRole"), [["reviewer", t("admin.role.reviewer")], ["support", t("admin.role.support")], ["operator", t("admin.role.operator")]]);
    const add = h("button", { class: "btn primary", type: "submit" }, icon("userPlus"), t("admin.staffAdd"));
    const error = h("p", { class: "error", role: "alert" });
    const form = h("form", { class: "form", novalidate: true }, h("div", { class: "form-grid" }, labelled(t("admin.staffEmail"), email), labelled(t("admin.staffRole"), role)), h("div", { class: "row" }, add), error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(add, error, async () => draw((await api("PUT", "/v1/admin/staff", { email: email.value.trim(), role: role.value })).staff));
    });
    const list = h(
      "ul",
      { class: "list" },
      staff.map((entry) =>
        h(
          "li",
          {},
          avatar(entry.name ?? entry.email, "sm"),
          h("div", { class: "grow" }, h("div", { class: "title" }, entry.name ?? entry.email, " ", h("span", { class: "chip line", text: t(`admin.role.${entry.role}`) }), entry.source === "env" ? h("span", { class: "chip mono", text: t("admin.fromEnv") }) : null), h("div", { class: "meta", text: `${entry.email} · ${t("admin.twofa")}: ${entry.twoFactor ? t("admin.on") : t("admin.off")}${entry.grantedBy ? ` · ${entry.grantedBy}` : ""}` })),
          entry.source === "table" && entry.userId !== state.me.user.id ? confirmButton(t("common.remove"), (button) => run(button, error, async () => draw((await api("DELETE", `/v1/admin/staff/${encodeURIComponent(entry.userId)}`)).staff))) : null,
        ),
      ),
    );
    card.replaceChildren(cardHead(t("admin.staffTitle"), "team"), h("p", { class: "lede", text: t("admin.staffLead") }), list, form);
  };
  api("GET", "/v1/admin/staff")
    .then((answer) => draw(answer.staff))
    .catch((error) => card.replaceChildren(cardHead(t("admin.staffTitle"), "team"), h("p", { class: "error", text: messageOf(error) })));
  return card;
}

// ---- Jurnal admin

function adminJournalRow(event) {
  return h(
    "tr",
    {},
    h("td", { class: "first small", style: "white-space:nowrap", text: fmtWhen(event.ts) }),
    h("td", { class: "small" }, h("span", { class: "state" }, avatar(event.actorName ?? "?", "sm"), h("span", {}, event.actorName ?? "-", h("br"), h("span", { class: "muted", text: event.actorEmail ?? "" })))),
    h("td", { class: "small mono", text: event.action }),
    h("td", { class: "small mono", text: event.target ?? "-" }),
    h("td", { class: "small mono" }, event.ip ?? "-", h("br"), h("span", { class: "muted", title: event.userAgent ?? "", text: event.deviceId ? event.deviceId.slice(0, 22) : "" })),
    h("td", { class: "small muted", lang: "en", text: [event.detail?.summary, event.detail?.reason ? `${t("admin.reason").split(" (")[0]}: ${event.detail.reason}` : null].filter(Boolean).join(" · ") }),
    h("td", { class: "small mono muted", title: event.hash, text: `#${event.chainSeq} ${event.hash.slice(0, 10)}` }),
  );
}

function adminJournal(panel) {
  let filters = {};
  let actions = [];
  const action = select(t("journal.action"), [["", t("journal.anyAction")]]);
  const table = pagedTable({
    columns: [t("journal.when"), t("journal.who"), t("journal.what"), t("admin.target"), t("journal.where"), t("journal.detail"), "hash"],
    fetchPage: async (page) => {
      const data = await api("GET", adminPath("/v1/admin/journal", { ...filters, page }));
      if (data.actions.join() !== actions.join()) {
        actions = data.actions;
        const keep = action.value;
        action.replaceChildren(h("option", { value: "", text: t("journal.anyAction") }), [...new Set(actions.map((a) => a.split(".").slice(0, 2).join(".")))].map((group) => h("option", { value: group, text: `${group}.*` })), actions.map((a) => h("option", { value: a, text: a })));
        action.value = keep;
      }
      return data;
    },
    row: adminJournalRow,
    empty: t("journal.none"),
  });
  const q = h("input", { type: "search", placeholder: t("admin.journalSearch"), "aria-label": t("admin.search") });
  const actor = h("input", { type: "email", placeholder: "nume@firma.example", "aria-label": t("admin.actor") });
  const from = h("input", { type: "date", "aria-label": t("journal.from") });
  const to = h("input", { type: "date", "aria-label": t("journal.to") });
  const error = h("p", { class: "error", role: "alert" });
  const exportAs = (button, format) =>
    run(button, error, async () => {
      const file = await api("GET", adminPath("/v1/admin/journal/export", { ...filters, format }));
      saveFile(file.filename, file.contentType, file.body);
    });
  const form = h(
    "form",
    { class: "form admin-filters", role: "search", novalidate: true },
    h("p", { class: "lede", text: t("admin.journalLead") }),
    h("div", { class: "form-grid" }, h("label", { class: "wide-2" }, t("admin.search"), q), labelled(t("journal.action"), action), labelled(t("admin.actor"), actor), labelled(t("journal.from"), from), labelled(t("journal.to"), to)),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, icon("search"), t("journal.search")), h("button", { class: "btn", type: "button", onclick: (event) => exportAs(event.currentTarget, "csv") }, icon("download"), `${t("journal.export")} CSV`), h("button", { class: "btn", type: "button", onclick: (event) => exportAs(event.currentTarget, "json") }, icon("download"), `${t("journal.export")} JSON`)),
    error,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    filters = { q: q.value.trim(), action: action.value, actor: actor.value.trim(), from: from.value, to: to.value };
    table.show(1);
  });
  const verifyOut = h("div", { class: "stack", role: "status" });
  const verifyButton = h("button", { class: "btn primary", type: "button" }, icon("checkCircle"), t("journal.verify"));
  const verifyError = h("p", { class: "error", role: "alert" });
  verifyButton.addEventListener("click", () =>
    run(verifyButton, verifyError, async () => {
      const result = await api("GET", "/v1/admin/journal/verify");
      verifyOut.replaceChildren(
        h("p", { class: result.ok ? "ok-line" : "error" }, icon(result.ok ? "check" : "alert"), result.ok ? t("admin.chainOk", { n: fmtNum(result.checked), hash: (result.head ?? "-").slice(0, 16) }) : t("admin.chainBroken", { n: result.brokenAt, reason: result.reason })),
        h("p", { class: "small muted", text: t("journal.anchors", { n: result.anchors.length }) }),
      );
    }),
  );
  table.show(1);
  panel.replaceChildren(h("section", { class: "card full" }, form), h("section", { class: "card full" }, table.el), h("section", { class: "card" }, cardHead(t("journal.verify"), "checkCircle"), h("div", { class: "row" }, verifyButton), verifyError, verifyOut));
}

// ---- Start -----------------------------------------------------------------------------------

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href^='/app/']") : null;
  if (link === null || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || link.target === "_blank") return;
  event.preventDefault();
  const url = new URL(link.href);
  history.pushState(null, "", `${url.pathname}${url.hash}`);
  route();
});
window.addEventListener("popstate", () => route());
route();
