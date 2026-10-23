## Hey claude-kun 
 what i bring to you today are issues and i want you to help me out without further audeu  lets start the list 
 - 1. - there are a lot of settings that shouldnt exist like the ones for changing quants, paths and some system one like icons things like that needs to be resolved 
 
 - 2. - the auto save is to slow and some behaviour and also the tts and stt and llm are slow and start very slow meaning they need a performance boost and if possible a models swap and some boost to then meaning its safe to swap kokoro and make the llm non bundled and instead use a new method of loading small models

 ```
we dont use path changing we do a different method a permanent folder that auto creates just one though with the local model in it so i can change the small model by swapping the one in the folder and if multiple exist you can select which one to use in the app
 ```

 - 3. - we need to revamp the writing areas some of it so it pivots to a write first environment 

 - 4. - the read aloud feature basically the tts has a wierd formatting which means 
      - you cant go forward or backword and it doesnt have a proper mini pill for the audio a small one though 
      - in the reader or the space it takes every line break as a change or basically a paragraph and it introduces a wierd gap or breakage in the audio which is bad also there are some unneceesary settings as well that are audio related which needs to be addressed 

 - 5. - speaking of settings we need to eliminate the settings that requires you to type what you want to change meaning it can save properly and is a preset not a place for making errors 

 - 6. -  the md reader is broken and bad looking and i want it to look like yours 
        -  fun fact one of your good features is your reader and previewer it is beautiful and top notch i would love for this app to have it but yet mine the md reader cant even accept tables 

 - 7. - for some people the app icons and buttons and majority of items are very small in size  which just means that we need a setting to increase them like the basic sliding to increase it 

 - 8. -  the widget is broken doesnt work dead as well as the settings that comes with it i tried but its all broken 

 - 9. - should i emphasize how bad it is to write in the writing app i am making this md in vs code and its a dozen times better than the foolish app cos of the feel vs code editor has a feel and experience to it and the app ships the codemirror dep already but doesnt use it 

 - 10. - the default files it should open are pdf txt md and others related to it i dont like using chrome to read pdf so make the app good enough to handle it which is a main reason for this app though as my default reader and opener and maker of files i got bored of notepad so i said hey let me make a fast super writing app that  will intrigue me to get writing and well 

 - 11. - i am not against web audio but well  it sounds mechanical too much which is why i said kokoro but oh well we can use a better tts right right right but in this case what does better mean if its quality i heard its the best but in this app it sounds like trash maybe there is an issue somewhere 

 - 12.
        - well basically the small model doesnt do the base job of the small model it or the auto correct doesnt work it doesnt format for me 
        -  backlinks doesnt work 
        - map just  dots all files which i am not sure how its sopposed to work [obsidian style]
        - notification is the same way nothing notifies 
        - also as a proper business model we need a private config for the new subscription of models since small models arent bundled but can be added auto there is no longer byok its a paid subscription same price as the single of notion works with the web and desktop version 1 sub 2 places lets say hmmm this will bring the need for a db like supabase which uhhhhhhhhhhh its a pain and i have been running away from for ever but it cant be helped right we just have to do what can be done 
     
 - 13. - a lot of features dont work like what they should do this is a logic issue like the
       - writing count shouldnt count imported docs as writing words 
       - autosave shouldnt swallow and take 10 seconds to save a single alphabet i beleive the reason is majorly because of the saving logic the way to save a file there are to many dbs to write to and the way to save it is  a pain thats what i call unnecesary over engineering just copy the basic way to save files maybe we do the flash keep alive that makes it survive when you close the app like every other app including vs code that requires ctrl s to  save it in a location which is the standard right 
       - same with the novel workspace there is so much clutter that it minimizes the main writing space to a small portion just because of big items like beat bord or things i dont even know work and the updating issues as well 
       - i dont mean to say this but the app is underusing some deps that are capable of much more i mentioned codemirror as one and there is typst and other packages that are underused also the stt there is no chance it works and i still dont know its use case but here is one expose a mic in almost all writing tab so it can transcribe and the small llm auto formats the text 
       - also i pivot to this we make the small llm a close to an agent meaning it doesnt just receives and writes prompt it works like direct access to the writing area like doc co-authoring, the auto  complete functions, formatting, searching and advance auto correct, and some proper structuring and more novel workspace brain 
       - speaking of auto correct well since the small model doesnt do it and will be a waste lets use the normal non ai way for auto correct with some rules attached to how it works like how the auto correct works on mobile it can learn skip names auto cap words and this inco-operates with the novel to skip all registered names and things like that basically the full mobile experience on a pc type of logic 
       - the web version now hmmm there is something to say majority of this will affect it i mean the desktop changes work on it as well right so on web it exposes some settings and behaviour that mirrors the desktop version meaning its reflecting and suggesting that the web is the desktop in some cases a real issue in logic 
       - back to the co authoring if we where to over engineer its doing speech to speech but nahh thats a pain 
       - the moat is the app is fast in reality its not really fast its laggy slow startup slow models slow process to first action even the reader is slow to use its import then click the doc again to read it 
       - also the settings shouldnt expose the delete the app thats trash logic 
       - the installer flow is old school just use the basic latest flow double click and let it install then it auto does it saves it to the right path and to the active user not the global usage for any user creates a desktop icon ease 
       - since we are here the bundled items is now the stt which is moonshine base at q8 gguf for fast inference and typst plus the new or still kokoro or any better tts model the small model isnt bundled but maybe we can make a small template of fine options like spark llm liquid 2.5 2.6b or basicaqlly good models based on the user hardware stats we can even use  a better way to load moe models so those are options as well i have the way but its in another codebase basically its using the same logic active experts in ram the rest in storage ready to be moved meaning only active weights are loaded and models that i will introduce is lfm 2.5 24b moe 2b active at q4 plus ling 3 tiny 8b 1b active and not an moe but bonsai 2 at q1 and maybe muse glimmer if its an moe 
       - this is just a template with plain download link to the hf nothing special 
       - templates yes we make more base writing templates not like github templates this is not a coding app i am a dev but also a writer i want to feel like a writer the templates should be base starters maybe letters poems story office docs and so on and fix the behaviour of the place to see them also the small or the model can also make scratch  templates based on prompts like make a starter for a proceeding or love letter and it lays the foundation for you to edit and customize to your taste so technically its not ai writting 
       - this is an advancement to the docs co-authorng to basically co-authoring
       - new additions is basically make the project a real project space basically its an isolated space with all the tabs and there tools available but with a reference folder for adding materials in it for you and you agent 
       - i keep on saying small model but dont get me wrong this is also do able with the big model as a matter of fact the same way there is a fick to use small model as main there should be one to use main as small as well 
       - the plugins like i suggested should use the same as obsidian meaning you can use obsidian pluggins in the app same ecosystem type shi 

 - 14. -  i am mentioning things i find off so you should also do your own audit as well and fix any issues make areas look good cleanup of real useless features you cant phantom a possible usage for and bugs and deps as well that needs addressing and also updatng of packages better home content daily reminder and notification templates only co- authoring is with ai no humans so you can even add a way for other ai to join in on the writing if its a pain to do skip if its a simple acp or mcp then proceed 

 - 15. - there is a lot of dumb code in the app so think of this as less of a fixing and more of a remake meaning you can rewrite  instead of making patches the codebase shoud be well documented for easy of use i might add the codegraph if you can use it as well so basically rewrite and remake then connect think as if you are taking over a noobs project for a overhaul so you can get hired and work full time you are to take over the code base you are the boss 

 - 16. - you are also allowed to do anything but a piece of advise thoughif its not broken dont break it always connect pieces together so they all function well make good templates i am trusting your skills use and remake the  system prompts and dont go for the dumb persona type lay your rules use my github.com/simply-ehis/small-model-harness to use as the harness for small models since we are pivoting to tools you can also take a look at the memory tech 

 - 17. - dont make overly long prompts though just use smart logic and also revamp settings as well it exposes somethings the wrong way and then make the base context length 16k and also prioritize that  when making the template for small modls to download per user machine all models should be q4 but welll thats my research to bring your job is to make the maths for running it like total memory usage expected and so on 

 - 18. - also make a good loading and offloading system and behaviour to prioritize performance and also the  right tags to use make the models faster and better like kv quant using available  cores auto prioritize ram [ i am using the vulkan llamacpp build so thats the best ]

 - 19. - using vs code made me like its writing behaviour that we could adapt like when making an md in plain text the headers and other sections can change color to highlight it and also auto closing of brackets as well there ai panel logic and the way it collaborates and writes the headers and spacing of tabs and the arrangemnts like bottom for the tags there the way you can make the writing area the biggest and center of attraction and main area and how you can make multiple previews in it and sections in the same tab and other ways it made its ui structured its perfect.
 what not to adapt is the code feel and extensions and the way its code oriented dont adapt that just take some pieces from it 

 - 20. - next is things like auto scroll and how it will work if you cant makr it good then dont make it and also the active area when reading aloud so it auto scrolls along. and other nice to have like [out of ideas dont just scope creep]
 note that when making also make it mobile responsive as wel and make most of the tech work on and android phone with just a little change [not the web app the desktop so even the local models and so on is easy to port to android and other features and so moving to a new device like mac is easy to do as well but this version is windows specisic so this is just a to know so you dont use windows only when there can be a global option as well]
     -priority is speed+performance+feel+quality+usabilty+niceness+uniqueness as a product and something worth paing for+ works any time+bettr than...+worth paying for +import usage + export flow + basic aitomation and least frustration + attention to detail [ even the themes as well] + smartness + engagement and naturalnes of all  and other writing spaces meaning the ease of use is and should be direct clear naming clean navigation and emty states so even an old man can use it [hence the increase in size of the app items including fonts and hiding of unnecessary items] 
     - i just remebered image support as well and other items that can be imported as well not just 3 items all that can be supported meaning anything that can be read in plain text like .logs .grammar etc can be imported and edited as well plus images docx and other files it can take in 


## well this was a lot more than i could ever imagine but this is also to prove to you the level of dis-satisfaction i have with this app 


``` 
 i wrote this by my self for bored reasons please handle the matter your self to make this better 
 